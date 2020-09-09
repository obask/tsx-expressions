import * as t from "@babel/types";
import { addNamed } from "@babel/helper-module-imports";
import config from "../config";

export const reservedNameSpaces = {
  style: true
};

export function registerImportMethod(path, name) {
  const imports =
    path.scope.getProgramParent().data.imports ||
    (path.scope.getProgramParent().data.imports = new Set());
  if (!imports.has(name)) {
    addNamed(path, name, config.moduleName, { nameHint: `_$${name}` });
    imports.add(name);
  }
}

function jsxElementNameToString(node) {
  if (t.isJSXMemberExpression(node)) {
    return `${jsxElementNameToString(node.object)}.${node.property.name}`;
  }
  if (t.isJSXIdentifier(node)) {
    return node.name;
  }
  return `${node.namespace.name}:${node.name.name}`;
}

export function tagNameToIdentifier(name) {
  const parts = name.split(".");
  if (parts.length === 1) return t.identifier(name);
  let part;
  let base = t.identifier(parts.shift());
  while ((part = parts.shift())) {
    base = t.memberExpression(base, t.identifier(part));
  }
  return base;
}

export function getTagName(tag) {
  const jsxName = tag.openingElement.name;
  return jsxElementNameToString(jsxName);
}

export function isComponent(tagName) {
  return (
    (tagName[0] && tagName[0].toLowerCase() !== tagName[0]) ||
    tagName.includes(".") ||
    /[^a-zA-Z]/.test(tagName[0])
  );
}

export function isDynamic(path, { checkMember, checkTags, checkCallExpressions = true }) {
  if (config.generate === "ssr" && !config.async) {
    checkMember = false;
    checkCallExpressions = false;
  }
  const expr = path.node;
  if (t.isFunction(expr)) return false;
  if (expr.leadingComments && expr.leadingComments[0].value.trim() === config.staticMarker) {
    expr.leadingComments.shift();
    return false;
  }
  if (
    (checkCallExpressions && t.isCallExpression(expr)) ||
    (checkMember && t.isMemberExpression(expr)) ||
    (checkTags && (t.isJSXElement(expr) || t.isJSXFragment(expr)))
  )
    return true;

  let dynamic;
  path.traverse({
    Function(p) {
      p.skip();
    },
    CallExpression(p) {
      checkCallExpressions && (dynamic = true) && p.stop();
    },
    MemberExpression(p) {
      checkMember && (dynamic = true) && p.stop();
    },
    JSXElement(p) {
      checkTags ? (dynamic = true) && p.stop() : p.skip();
    },
    JSXFragment(p) {
      checkTags ? (dynamic = true) && p.stop() : p.skip();
    }
  });
  return dynamic;
}

export function isStaticExpressionContainer(path) {
  const node = path.node;
  return (
    t.isJSXExpressionContainer(node) &&
    t.isJSXElement(path.parent) &&
    !isComponent(getTagName(path.parent)) &&
    (t.isStringLiteral(node.expression) ||
      t.isNumericLiteral(node.expression) ||
      (t.isTemplateLiteral(node.expression) && node.expression.expressions.length === 0))
  );
}

// remove unnecessary JSX Text nodes
export function filterChildren(children, loose) {
  return children.filter(
    ({ node: child }) =>
      !(t.isJSXExpressionContainer(child) && t.isJSXEmptyExpression(child.expression)) &&
      (!t.isJSXText(child) ||
        (loose ? !/^[\r\n]\s*$/.test(child.extra.raw) : !/^\s*$/.test(child.extra.raw)))
  );
}

export function checkLength(children) {
  let i = 0;
  children.forEach(path => {
    const child = path.node;
    !(t.isJSXExpressionContainer(child) && t.isJSXEmptyExpression(child.expression)) &&
      (!t.isJSXText(child) || !/^\s*$/.test(child.extra.raw)) &&
      i++;
  });
  return i > 1;
}

export function trimWhitespace(text) {
  text = text.replace(/\r/g, "");
  if (/\n/g.test(text)) {
    text = text
      .split("\n")
      .map((t, i) => (i ? t.replace(/^\s*/g, "") : t))
      .filter(s => !/^\s*$/.test(s))
      .join(" ");
  }
  return text.replace(/\s+/g, " ");
}

export function toEventName(name) {
  return name.slice(2).toLowerCase();
}

export function transformCondition(path, deep) {
  const expr = path.node;
  registerImportMethod(path, "memo");
  let dTest, cond, id;
  if (
    t.isConditionalExpression(expr) &&
    (isDynamic(path.get("consequent"), {
      checkTags: true
    }) ||
      isDynamic(path.get("alternate"), { checkTags: true }))
  ) {
    dTest = isDynamic(path.get("test"), { checkMember: true });
    if (dTest) {
      cond = expr.test;
      id = path.scope.generateUidIdentifier("_c$");
      if (!t.isBinaryExpression(cond))
        cond = t.unaryExpression("!", t.unaryExpression("!", cond, true), true);
      expr.test = t.callExpression(id, []);
      if (t.isConditionalExpression(expr.consequent) || t.isLogicalExpression(expr.consequent)) {
        expr.consequent = transformCondition(path.get("consequent"), true);
      }
      if (t.isConditionalExpression(expr.alternate) || t.isLogicalExpression(expr.alternate)) {
        expr.alternate = transformCondition(path.get("alternate"), true);
      }
    }
  } else if (t.isLogicalExpression(expr)) {
    let nextPath = path;
    // handle top-level or, ie cond && <A/> || <B/>
    if (expr.operator === "||" && t.isLogicalExpression(expr.left)) {
      nextPath = nextPath.get("left");
    }
    isDynamic(nextPath.get("right"), { checkTags: true }) &&
      (dTest = isDynamic(nextPath.get("left"), {
        checkMember: true
      }));
    if (dTest) {
      cond = nextPath.node.left;
      id = path.scope.generateUidIdentifier("_c$")
      if (expr.operator !== "||" && !t.isBinaryExpression(cond))
        cond = t.unaryExpression("!", t.unaryExpression("!", cond, true), true);
      nextPath.node.left = t.callExpression(id, []);
    }
  }
  if (dTest) {
    const statements = [
      t.variableDeclaration("const", [
        t.variableDeclarator(
         id,
          t.callExpression(t.identifier("_$memo"), [
            t.arrowFunctionExpression([], cond),
            t.booleanLiteral(true)
          ])
        )
      ]),
      t.arrowFunctionExpression([], expr)
    ];
    return deep
      ? t.callExpression(
          t.arrowFunctionExpression(
            [],
            t.blockStatement([statements[0], t.returnStatement(statements[1])])
          ),
          []
        )
      : statements;
  }
  return deep ? expr : t.arrowFunctionExpression([], expr);
}

const ATTR_REGEX = /[&<"]/g,
  CONTENT_REGEX = /[&<]/g;

export function escapeHTML(html, attr) {
  if (typeof html !== "string") return html;
  const match = (attr ? ATTR_REGEX : CONTENT_REGEX).exec(html);
  if (!match) return html;
  let index = 0;
  let lastIndex = 0;
  let out = "";
  let escape = "";
  for (index = match.index; index < html.length; index++) {
    switch (html.charCodeAt(index)) {
      case 34: // "
        escape = "&quot;";
        break;
      case 38: // &
        escape = "&amp;";
        break;
      case 60: // <
        escape = "&lt;";
        break;
      default:
        continue;
    }
    if (lastIndex !== index) out += html.substring(lastIndex, index);
    lastIndex = index + 1;
    out += escape;
  }
  return lastIndex !== index ? out + html.substring(lastIndex, index) : out;
}
