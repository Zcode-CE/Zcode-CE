import { CheckError, MAX_MEMBER_ELEMENTS, MAX_TOTAL_ELEMENTS } from "./office-spec.mjs";
import {
  XMLNS_NAMESPACE_URI,
  XML_NAMESPACE_PREFIX,
  XML_NAMESPACE_URI,
  decodeEntities,
  decodeXmlBytes,
  firstNonSpace,
  isNameChar,
  isNameStart,
  isXmlSpace,
  xmlError,
} from "./office-xml-lex.mjs";
import {
  checkQualifiedName,
  readDoctype,
  readProcessingInstructionTarget,
  readXmlDeclaration,
  resolveName,
} from "./office-xml-decl.mjs";
import { addChild, attributeOf, createElement, setAttribute } from "./office-xml-tree.mjs";

// --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
// 归属:      ZCode-CE 自研（self）—— 不是 DSH 上游文件，不回写上游，不跟 DSH 发版
// 由来:      scripts/check_office.py（derived-from-dsh，MIT）的 Node 重写，按职责拆分。
// 本模块:    XML 扫描器（元素预算在此中止）
// 同名副本:  三份（documents/presentations/spreadsheets）必须逐字节相同，改一处同步三处
// 回归测试:  apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs
// ---------------------------------------------------------------------------

function parseXmlMember(name, data, budget) {
  const text = decodeXmlBytes(data, name);
  const rootScope = new Map([[XML_NAMESPACE_PREFIX, XML_NAMESPACE_URI]]);
  rootScope.parent = null;
  const context = { text, part: name, count: 0, budget };
  const root = createElement("", rootScope);
  const stack = [root];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("<", cursor);
    const dataEnd = open === -1 ? text.length : open;
    if (dataEnd > cursor) readCharacterData(context, stack, cursor, dataEnd);
    if (open === -1) break;
    cursor = readMarkup(context, stack, open);
  }
  if (context.count === 0 || stack.length > 1) {
    throw xmlError(text, text.length, "no element found");
  }
  budget.elements += context.count;
  return root.children[0];
}

/** 元素外的字符数据（根元素之前/之后）只允许空白；元素内则计入当前元素的 text。 */
function readCharacterData(context, stack, start, end) {
  const top = stack[stack.length - 1];
  if (stack.length > 1) {
    // 与 ElementTree 一致：text 只累积第一个子元素之前的字符数据。
    if (top.children !== undefined) return;
    top.text += decodeEntities(context.text.slice(start, end), context, {
      malformed: end,
      entity: (amp) => start + amp,
      character: (amp, width) => start + amp + width,
    });
    return;
  }
  const offset = firstNonSpace(context.text, start, end);
  if (offset === -1) return;
  // expat 的两条分支：非空白串后面直接跟 '<' 时按非法 token 报在 '<' 上；
  // 后面是空白或文件结束时按文档级错误报在串首（列号从 0 起）。
  const tail = context.text.slice(offset, end);
  const gap = tail.search(/\s/);
  if (gap !== -1 || end >= context.text.length) {
    const message = context.count === 0 ? "syntax error" : "junk after document element";
    throw xmlError(context.text, offset, message);
  }
  throw xmlError(context.text, end, "not well-formed (invalid token)");
}

/** 读一个标记（注释 / CDATA / 声明 / 元素标签），返回下一个扫描位置。 */
function readMarkup(context, stack, open) {
  const text = context.text;
  const outside = stack.length === 1;
  if (text.startsWith("<!--", open)) {
    const end = text.indexOf("-->", open + 4);
    if (end === -1) throw xmlError(text, open, "unclosed token");
    return end + 3;
  }
  if (text.startsWith("<![CDATA[", open)) {
    const end = text.indexOf("]]>", open + 9);
    if (end === -1) throw xmlError(text, text.length, "unclosed CDATA section");
    if (outside) {
      const message = context.count === 0 ? "syntax error" : "junk after document element";
      throw xmlError(text, open, message);
    }
    const top = stack[stack.length - 1];
    if (top.children === undefined) top.text += text.slice(open + 9, end);
    return end + 3;
  }
  if (text.startsWith("<?", open)) {
    const end = text.indexOf("?>", open + 2);
    if (end === -1) throw xmlError(text, open, "unclosed token");
    const target = readProcessingInstructionTarget(context, open, end);
    if (target === "xml") readXmlDeclaration(context, open, end, outside);
    return end + 2;
  }
  if (text.startsWith("<!", open)) {
    if (!text.startsWith("<!DOCTYPE", open)) {
      // expat 只把 <!DOCTYPE 当声明；"<!x>"、"<!DOCTYP" 等一律是非法 token。
      // 位置规则：文件最开头报在 token 内首字符（offset 2），其余位置报在 '<' 上。
      const atStart = context.count === 0 && open === 0;
      throw xmlError(text, atStart ? open + 2 : open, "not well-formed (invalid token)");
    }
    return readDoctype(context, open);
  }
  if (outside && context.count > 0) {
    throw xmlError(text, open, "junk after document element");
  }
  const closing = text.startsWith("</", open);
  const tagStart = open + (closing ? 2 : 1);
  let tagEnd = -1;
  let quote = "";
  for (let index = tagStart; index < text.length; index += 1) {
    const ch = text[index];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      tagEnd = index;
      break;
    }
  }
  if (tagEnd === -1) throw xmlError(text, open, "unclosed token");
  const body = text.slice(tagStart, tagEnd);
  if (closing) {
    const qualifiedName = body.trim();
    // 结束标签的名字不能以 ':' 开头；expat 只在这里做名字合法性检查，其余形状问题
    // （"</a:>"、"</a::b>"）都落到 mismatched tag —— 与 ElementTree 的报错一致。
    if (qualifiedName === "" || !isNameStart(qualifiedName[0]) || qualifiedName[0] === ":") {
      throw xmlError(text, tagStart, "not well-formed (invalid token)");
    }
    const current = stack[stack.length - 1];
    if (stack.length <= 1 || current.name !== qualifiedName) {
      // expat 把 mismatched tag 报在结束标签的名字首字符上（不是 '<'），位置需对齐。
      throw xmlError(text, tagStart, "mismatched tag");
    }
    stack.pop();
    return tagEnd + 1;
  }
  const selfClosing = body.endsWith("/");
  const inner = selfClosing ? body.slice(0, -1) : body;
  const nameStart = firstNonSpace(inner, 0, inner.length);
  if (nameStart === -1) throw xmlError(text, tagStart, "not well-formed (invalid token)");
  if (inner[nameStart] === "/") {
    // "<a/ >" 这类：'/' 必须紧跟 '>'，expat 报在 '/' 之后那个字符上。
    throw xmlError(text, tagStart + nameStart + 1, "not well-formed (invalid token)");
  }
  if (!isNameStart(inner[nameStart])) {
    throw xmlError(text, tagStart + nameStart, "not well-formed (invalid token)");
  }
  let nameEnd = nameStart;
  while (nameEnd < inner.length && isNameChar(inner[nameEnd])) nameEnd += 1;
  checkQualifiedName(context, inner, nameStart, nameEnd, tagStart);
  const qualifiedName = inner.slice(nameStart, nameEnd);
  const element = createElement(qualifiedName, stack[stack.length - 1].scope);
  readAttributes(context, inner.slice(nameEnd), tagStart + nameEnd, element, open);
  element.tag = resolveName(context, qualifiedName, element.scope, false, open);
  addChild(stack[stack.length - 1], element);
  context.count += 1;
  if (context.count > MAX_MEMBER_ELEMENTS) {
    throw new CheckError(
      context.part +
        ": XML element count exceeds the " +
        MAX_MEMBER_ELEMENTS +
        " element per-member limit",
    );
  }
  if (context.budget.elements + context.count > MAX_TOTAL_ELEMENTS) {
    throw new CheckError(
      "package XML element count exceeds the " +
        MAX_TOTAL_ELEMENTS +
        " element budget at " +
        context.part,
    );
  }
  if (!selfClosing) stack.push(element);
  return tagEnd + 1;
}

/**
 * 解析开始标签里的属性；xmlns 声明进作用域，其余按 XML 规则解析前缀（默认命名空间不作用于属性）。
 *
 * 为什么必须分两遍（FIX-DOCX 修复的真实缺陷）：命名空间声明的作用范围是**整个元素**，
 * 与属性的文档序无关（Namespaces in XML 1.0 §6.2：声明作用于「其所在元素及其属性」）。
 * 而 docx@9.7.1 产出的根标签顺序是 `mc:Ignorable="w14 w15 wp14"` 在前、`xmlns:mc` 在后 ——
 * 单遍按文档序解析会在第 0 个属性上就抛 `unbound prefix`，把**合法**文档判成 fail。
 * 实测：同一份 docx 库产物，`.mjs` 判 fail（`unbound prefix: line 1, column 55`）、`.py`（expat）判 pass。
 *
 * 修复方向是**对齐 expat 的语义**，不是放松检查：第一遍只做词法校验并收集本元素的 xmlns 声明，
 * 第二遍才按文档序解析其余属性的前缀。真正未声明的前缀（`<r zz:x="1"/>`）仍然照旧报错，
 * 因为第二遍解析时作用域里同样没有 `zz`。
 */
function readAttributes(context, region, regionStart, element, tagOpen) {
  let cursor = 0;
  let declared = false;
  // 第一遍收集、第二遍解析的非 xmlns 属性；扁平三元组 [rawName, value, nameStart, ...]，
  // 与 element.attrib 同样用扁平数组而不是对象数组，避免每个属性多付一个对象的常驻开销
  // （元素/属性单实例开销直接决定峰值内存，见 docs/development/office-plugins.md §4bis）。
  const pending = [];
  // 本元素已声明过的命名空间前缀（默认命名空间用 "" 表示）。只在元素真的写了 xmlns 时分配，
  // 保持「没有命名空间声明的元素不付额外开销」这条既有性质（见 §4bis）。
  let declaredPrefixes = null;
  while (cursor < region.length) {
    while (cursor < region.length && isXmlSpace(region[cursor])) cursor += 1;
    if (cursor >= region.length) break;
    const nameStart = cursor;
    if (!isNameStart(region[cursor])) {
      throw xmlError(context.text, regionStart + cursor, "not well-formed (invalid token)");
    }
    while (cursor < region.length && isNameChar(region[cursor])) cursor += 1;
    checkQualifiedName(context, region, nameStart, cursor, regionStart);
    const rawName = region.slice(nameStart, cursor);
    while (cursor < region.length && isXmlSpace(region[cursor])) cursor += 1;
    if (region[cursor] !== "=") {
      throw xmlError(context.text, regionStart + cursor, "not well-formed (invalid token)");
    }
    cursor += 1;
    while (cursor < region.length && isXmlSpace(region[cursor])) cursor += 1;
    const quote = region[cursor];
    if (quote !== '"' && quote !== "'") {
      throw xmlError(context.text, regionStart + cursor, "not well-formed (invalid token)");
    }
    const valueEnd = region.indexOf(quote, cursor + 1);
    if (valueEnd === -1) throw xmlError(context.text, tagOpen, "unclosed token");
    // 属性值里不允许裸 '<'（必须写成 &lt;）；expat 报在该字符上。
    const rawLt = region.indexOf("<", cursor + 1);
    if (rawLt !== -1 && rawLt < valueEnd) {
      throw xmlError(context.text, regionStart + rawLt, "not well-formed (invalid token)");
    }
    const rawValue = region.slice(cursor + 1, valueEnd).replace(/[\t\r\n]/g, " ");
    cursor = valueEnd + 1;
    // 属性之间必须有空白：b="1"c="2" 是非法 token（报在第二个属性名首字符上）。
    if (cursor < region.length && !isXmlSpace(region[cursor])) {
      throw xmlError(context.text, regionStart + cursor, "not well-formed (invalid token)");
    }
    const value = decodeEntities(rawValue, context, {
      malformed: tagOpen,
      entity: () => tagOpen,
      character: () => tagOpen,
    });
    if (rawName === "xmlns" || rawName.startsWith("xmlns:")) {
      const prefix = rawName === "xmlns" ? "" : rawName.slice(6);
      if (declaredPrefixes === null) declaredPrefixes = new Set();
      // 同一元素里重复声明同一前缀：expat 报 duplicate attribute（报在第二个声明的名字上）。
      // 不分两遍时这条被「先声明的会被后声明的静默覆盖」掩盖 —— 校验器放行非法输入，
      // 是最不该有的失效方向。补齐后 readAttributes 与 .py（expat）在这一类上一致。
      if (declaredPrefixes.has(prefix)) {
        throw xmlError(context.text, regionStart + nameStart, "duplicate attribute");
      }
      declaredPrefixes.add(prefix);
      // 以下保留前缀/保留 URI 规则都对齐 expat（Namespaces in XML 1.0 §3、§4），
      // 顺序也与 expat 一致：先查「重复声明」，再查值与前缀的合法性。
      // 报错位置统一是**标签起点**（expat 实测：`<r><a xmlns:xmlns="v"/></r>` 报 col 3 = "<a" 的 "<"）。
      if (prefix !== "" && value === "") {
        // 非默认前缀不得取消声明（XML 1.0 无 undeclare；默认命名空间置空是合法的）。
        throw xmlError(context.text, tagOpen, "must not undeclare prefix");
      }
      if (prefix === "xmlns") {
        // 保留前缀 xmlns 不得被声明。若只按 slice(6) 取前缀，`xmlns:xmlns="x"` 会把 "xmlns"
        // 当成普通前缀静默写进作用域 —— 校验器放行非法输入。
        throw xmlError(
          context.text,
          tagOpen,
          "reserved prefix (xmlns) must not be declared or undeclared",
        );
      }
      if (prefix === "xml" && value !== XML_NAMESPACE_URI) {
        // xml 前缀只能绑定到它自己的命名空间（未声明时的隐式绑定由 rootScope 提供）。
        throw xmlError(
          context.text,
          tagOpen,
          "reserved prefix (xml) must not be undeclared or bound to another namespace name",
        );
      }
      if (value === XMLNS_NAMESPACE_URI || (value === XML_NAMESPACE_URI && prefix !== "xml")) {
        // 保留 URI 不得被其它前缀（含默认命名空间）绑定；唯一例外是 xml 前缀绑定自己的 URI，
        // 那条在上面的分支里已放行（实测 expat：`xmlns:xml="<XML_URI>"` 合法）。
        throw xmlError(
          context.text,
          tagOpen,
          "prefix must not be bound to one of the reserved namespace names",
        );
      }
      // 只有真的声明了命名空间才复制作用域帧（链式），避免每个元素一个 Map。
      if (!declared) {
        // 只挂 parent 链，**不复制父链**：scopeLookup（office-xml-tree.mjs）本来就沿 parent
        // 上溯查找，复制父链是纯冗余，且使嵌套 N 层的开销变成 O(N²)。
        // 实测（安全审计 P0）：16000 层、每层声明不同前缀的 40 KB docx，
        // 旧写法峰值 RSS 4263 MiB 并 SIGABRT（stdout 为空）；改为空 Map 后 77 MiB，
        // 与 .py 版（28~33 MiB、stdout 195 字节）行为一致。
        const frame = new Map();
        frame.parent = element.scope;
        element.scope = frame;
        declared = true;
      }
      element.scope.set(prefix, value);
      continue;
    }
    // 第一遍只做词法校验与收集，**不解析前缀**：此时本元素后面的 xmlns 声明可能还没读到。
    pending.push(rawName, value, nameStart);
  }
  // 第二遍：本元素的 xmlns 声明已全部进作用域，再按文档序解析其余属性。
  for (let index = 0; index < pending.length; index += 3) {
    const rawName = pending[index];
    const key = resolveName(context, rawName, element.scope, true, tagOpen);
    if (attributeOf(element, key) !== undefined) {
      throw xmlError(context.text, regionStart + pending[index + 2], "duplicate attribute");
    }
    setAttribute(element, key, pending[index + 1]);
  }
}

/**
 * 校验 QName 形状：最多一个冒号，且两侧都不能为空（"z:"、"a:b:c"、"b:" 都是非法 token）。
 *
 * 位置对齐 expat：报在冒号或本地名首字符上。
 */

export { parseXmlMember };
export { readAttributes };
export { readCharacterData };
export { readMarkup };
