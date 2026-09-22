// --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
// 归属:      ZCode-CE 自研（self）—— 不是 DSH 上游文件，不回写上游，不跟 DSH 发版
// 由来:      scripts/check_office.py（derived-from-dsh，MIT）的 Node 重写，按职责拆分。
// 本模块:    XML 元素树与访问器
// 同名副本:  三份（documents/presentations/spreadsheets）必须逐字节相同，改一处同步三处
// 回归测试:  apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs
// ---------------------------------------------------------------------------

function createElement(name, scope) {
  return { name, tag: name, text: "", scope };
}

/** 子元素列表按需创建：叶子元素（典型 OOXML 里的 <w:t/>、<x/>）不付这个代价。 */
function addChild(element, child) {
  if (element.children === undefined) element.children = [];
  element.children.push(child);
}

/** 按 Clark 记法取属性值（等价 Element.get(name)）。 */
function attributeOf(element, name) {
  const attrib = element.attrib;
  if (attrib === undefined) return undefined;
  for (let index = 0; index < attrib.length; index += 2) {
    if (attrib[index] === name) return attrib[index + 1];
  }
  return undefined;
}

/** 按 Clark 记法写入属性（等价 Element.set(name, value)）。 */
function setAttribute(element, name, value) {
  if (element.attrib === undefined) element.attrib = [];
  element.attrib.push(name, value);
}

/**
 * 作用域：以「声明链」表示前缀绑定，避免每个元素复制一份 Map。
 *
 * 只有真正写了 xmlns/xmlns:* 的元素才挂一帧；查找时沿链上溯（帧数 = 嵌套的
 * 命名空间声明深度，实际文档里通常是个位数）。
 */
function scopeLookup(scope, prefix) {
  let frame = scope;
  while (frame !== null) {
    const value = frame.get(prefix);
    if (value !== undefined) return value;
    frame = frame.parent;
  }
  return undefined;
}

/**
 * 解析一个 XML 成员，边建树边按元素预算计数，超限立即停下。
 *
 * 为什么不用一次性建完整棵树：超限时内存已经吃满，只能在事后抛内存错误（修复前 2 GiB
 * 夹具上正是如此）。这里在扫描过程中计数，一旦超预算立刻停止，峰值内存只到预算为止。
 */
function findChild(element, tag) {
  const children = element.children;
  if (children === undefined) return undefined;
  for (const child of children) {
    if (child.tag === tag) return child;
  }
  return undefined;
}

function findChildren(element, tag) {
  const children = element.children;
  if (children === undefined) return [];
  return children.filter((child) => child.tag === tag);
}

/** 对应 Element.find("a/b")：逐级取第一个匹配的直接子元素。 */
function findPath(element, path) {
  let current = element;
  for (const tag of path) {
    current = findChild(current, tag);
    if (current === undefined) return undefined;
  }
  return current;
}

/** 对应 Element.findall("a/b")：先按路径走到父级，再取所有匹配的直接子元素。 */
function findPathAll(element, path) {
  const parent = findPath(element, path.slice(0, -1));
  if (parent === undefined) return [];
  return findChildren(parent, path[path.length - 1]);
}

/** 对应 Element.iter(tag)：文档序（先序）遍历整棵子树。 */
function* iterElements(element, tag) {
  const stack = [element];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.tag === tag) yield current;
    const children = current.children;
    if (children === undefined) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
}

/** 对应 Element.findtext(tag, default)。 */
function findText(element, tag, fallback) {
  const child = findChild(element, tag);
  return child === undefined ? fallback : child.text;
}

/** 属性名去掉命名空间前缀（同 key.removeprefix(w)），保持文档序。 */
function withoutNamespace(attrib, uri) {
  const out = {};
  if (attrib === undefined) return out;
  for (let index = 0; index < attrib.length; index += 2) {
    const key = attrib[index];
    out[key.startsWith(uri) ? key.slice(uri.length) : key] = attrib[index + 1];
  }
  return out;
}

export { addChild };
export { attributeOf };
export { createElement };
export { findChild };
export { findChildren };
export { findPath };
export { findPathAll };
export { findText };
export { iterElements };
export { scopeLookup };
export { setAttribute };
export { withoutNamespace };
