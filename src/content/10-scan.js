/**
 * DOM 扫描：把页面上的表单控件找出来，并为每个控件采集所有能表明它语义的信号。
 *
 * 这个文件只读 DOM，不写。填充在 40-fill.js。
 */
(function (root) {
  'use strict';

  const RA = root.RA;
  const N = RA.normalize;

  // ─────────────────────────── 跳过规则 ───────────────────────────

  const SKIP_TYPES = new Set([
    'hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'search',
  ]);

  /** 我们自己注入的浮层要跳过，否则会把 UI 上的输入框也当成表单字段 */
  const IGNORE_ATTR = 'data-ra-ignore';

  /**
   * 自定义组件（下拉、日期选择器、级联选择）的容器选择器。
   *
   * 为什么要单独列出来：这些组件内层的 input 通常是 readonly（甚至是隐藏的），
   * 真正干活的是外面那层 div。如果按「readonly 一律跳过」处理，
   * 整个控件就永远不会进入候选列表——这正是「下拉框完全填不了」的根因。
   */
  const WIDGET_SEL = [
    '.ant-select', '.ant-picker', '.ant-cascader', '.ant-tree-select',
    '.el-select', '.el-date-editor', '.el-cascader', '.el-time-picker',
    '.ivu-select', '.ivu-date-picker', '.ivu-cascader',
    '.van-field', '.arco-select', '.arco-picker', '.semi-select',
    '[role="combobox"]', '[aria-haspopup="listbox"]',
  ].join(',');

  /** 疑似验证码 / 搜索框，不要填 */
  const JUNK_ALIASES = ['验证码', '短信验证码', '图形验证码', 'captcha', 'verifycode', 'search', '搜索', '查询', 'keyword'];

  /**
   * 动态 class（CSS-in-JS 的哈希、Angular 的 _ngcontent 之类）对匹配毫无价值，
   * 而且每次构建都变，必须剥掉，否则它们会污染特征串、也会让调试输出没法看。
   */
  function stripDynamicTokens(s) {
    if (!s) return '';
    return String(s)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ' ')
      .replace(/\b(?:css|sc|jsx|emotion)-[a-z0-9]{5,}\b/gi, ' ')
      .replace(/\b_ngcontent-[a-z0-9-]+\b/gi, ' ')
      .replace(/\bng-tns-[a-z0-9-]+\b/gi, ' ')
      .replace(/\b_r_[0-9a-z]+_\b/gi, ' ')
      .replace(/\bdata-v-[a-f0-9]+\b/gi, ' ')
      .replace(/\bctl\d+\$/gi, ' ')
      .replace(/:[rR][0-9a-z]*:/g, ' ')
      .replace(/\d{4,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 占位符如果长得像一个「示例值」而不是一个「标签」，那就不能当标签用 */
  function isValueLikePlaceholder(p) {
    if (!p) return false;
    const s = String(p).trim();
    if (/^(例|例如|示例|举例|如|e\.?g\.?|ex\.?|example|input|enter)\b/i.test(s)) return true;
    // 纯示例值：张三 / 13800138000 / abc@x.com / 2020-01-01
    if (/^1[3-9]\d{9}$/.test(s)) return true;
    if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(s)) return true;
    if (/^\d{4}[-\/年]\d{1,2}([-\/月]\d{1,2}日?)?$/.test(s)) return true;
    if (/^[一-鿿]{2,4}$/.test(s) && !/(请|输入|填写|选择|您的|你的)/.test(s)) return true;
    return false;
  }

  /** 描述性 placeholder（「请输入手机号」）才是真标签 */
  function isDescriptivePlaceholder(p) {
    if (!p) return false;
    return /(请|输入|填写|选择|您的|你的|enter|please|select|type)/i.test(String(p));
  }

  // ─────────────────────────── 标签解析 ───────────────────────────

  /** 取元素自身的文本，跳过嵌套的控件/脚本/样式，避免把 select 的选项文字混进来 */
  function ownText(el, depth = 0) {
    if (!el || depth > 6) return '';
    let out = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue;
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' ||
            tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE' ||
            tag === 'SVG' || child.hasAttribute(IGNORE_ATTR)) {
          continue;
        }
        out += ' ' + ownText(child, depth + 1);
      }
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  const FORM_ITEM_SEL = [
    '[class*="form-item"]', '[class*="formitem"]', '[class*="form-item"]',
    '[class*="form-group"]', '[class*="formgroup"]', '[class*="field"]',
    '[class*="ant-form-item"]', '[class*="el-form-item"]', '[class*="ivu-form-item"]',
    'li', 'dd', 'td',
  ].join(',');

  // 每个控件会被反复问「你的表单项容器是谁」（解析标签、取邻近文本、区块投票都要用）。
  // 每次都沿祖先链做 querySelectorAll 在大页面上开销可观，缓存一下。
  let containerCache = new WeakMap();

  /** 往上找最近的「表单项容器」——一个包含本控件、且不带其他控件的祖先 */
  function formItemContainer(el, maxDepth = 6) {
    const cached = containerCache.get(el);
    if (cached !== undefined) return cached;

    let node = el.parentElement;
    let fallback = el.parentElement;
    let found = null;
    for (let i = 0; i < maxDepth && node && node !== document.body; i++) {
      const controls = node.querySelectorAll('input:not([type=hidden]),select,textarea');
      if (controls.length === 1) {
        fallback = node;
        if (node.matches && node.matches(FORM_ITEM_SEL)) { found = node; break; }
      }
      node = node.parentElement;
    }
    const result = found || fallback;
    containerCache.set(el, result);
    return result;
  }

  const LABEL_CLASS_RE = /(^|[-_])(label|title|name|caption|field-label|form-label)($|[-_])/i;

  /** 框架把标签渲染成 div/span 而不是 <label>，必须单独找 */
  function frameworkLabel(itemEl) {
    if (!itemEl) return null;
    const cands = itemEl.querySelectorAll(
      '.ant-form-item-label, .el-form-item__label, .ivu-form-item-label, ' +
      '.van-field__label, [class*="form-item__label"], [class*="form-label"], [class*="field-label"]'
    );
    for (const c of cands) {
      const t = ownText(c);
      if (t) return { text: t, source: 'framework' };
    }
    // 再宽松一点：class 里带 label 的短文本元素
    for (const c of itemEl.querySelectorAll('[class]')) {
      const cls = c.getAttribute('class') || '';
      if (!LABEL_CLASS_RE.test(cls)) continue;
      const t = ownText(c);
      // 标签一般很短，太长的多半是说明文字
      if (t && t.length <= 24) return { text: t, source: 'framework-weak' };
    }
    return null;
  }

  function findByFor(id) {
    if (!id) return null;
    try {
      return document.querySelector(`label[for="${CSS.escape(id)}"]`);
    } catch (e) {
      return null;
    }
  }

  /**
   * 标签解析链。越靠前的越可靠。
   * @returns {{text: string, source: string}|null}
   */
  function resolveLabel(el) {
    // 1. aria-labelledby —— 显式声明，最可靠
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const parts = lb.split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? ownText(n) : '';
        })
        .filter(Boolean);
      if (parts.length) return { text: parts.join(' '), source: 'aria-labelledby' };
    }

    // 2. aria-label
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return { text: al.trim(), source: 'aria-label' };

    // 3. <label for="...">
    const byFor = findByFor(el.id);
    if (byFor) {
      const t = ownText(byFor);
      if (t) return { text: t, source: 'for' };
    }

    // 4. 包裹式 <label>
    const wrap = el.closest('label');
    if (wrap) {
      const t = ownText(wrap);
      if (t) return { text: t, source: 'wrap' };
    }

    // 5. fieldset/legend
    const fs = el.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg) {
        const t = ownText(lg);
        if (t) return { text: t, source: 'legend' };
      }
    }

    // 6. 框架标签
    const item = formItemContainer(el);
    const fw = frameworkLabel(item);
    if (fw) return fw;

    // 7. 容器内的其他文本（很多手写表单就是 <div><span>姓名</span><input></div>）
    if (item) {
      const t = ownText(item);
      if (t && t.length <= 30) return { text: t, source: 'container' };
    }

    return null;
  }

  /**
   * 几何相邻文本。
   * 这是最后的兜底手段，代价是一次 getBoundingClientRect 布局计算，
   * 所以只在前面所有手段都失败时才调用。
   */
  function geometricNeighbor(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;

    const cy = r.top + r.height / 2;
    const scope = el.closest('form') || el.closest('[class*="form"]') || document.body;
    let best = null;
    let bestScore = Infinity;

    for (const node of scope.querySelectorAll('*')) {
      if (node.contains(el) || el.contains(node)) continue;
      if (node.children.length > 0) continue; // 只看叶子节点，避免整块容器被选中
      if (node.tagName === 'INPUT' || node.tagName === 'SELECT' ||
          node.tagName === 'TEXTAREA' || node.tagName === 'BUTTON' ||
          node.tagName === 'SCRIPT' || node.tagName === 'STYLE' ||
          node.hasAttribute(IGNORE_ATTR)) continue;

      const t = (node.textContent || '').trim();
      if (!t || t.length > 24) continue;

      const nr = node.getBoundingClientRect();
      if (!nr.width && !nr.height) continue;

      // 同一行（垂直中心接近）
      const onSameRow = Math.abs((nr.top + nr.height / 2) - cy) < Math.max(r.height, nr.height) * 0.8;
      if (!onSameRow) continue;

      // 必须在输入框左侧
      const dx = r.left - nr.right;
      if (dx < -4 || dx > r.width * 3) continue;

      const score = dx + Math.abs((nr.top + nr.height / 2) - cy) * 2;
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best ? { text: best, source: 'geometric' } : null;
  }

  /** 表格布局：<td>姓名</td><td><input></td> */
  function cellText(el) {
    const td = el.closest('td');
    if (!td) return null;

    // 先看表头同一列（更准确）
    const table = td.closest('table');
    if (table) {
      const cellIndex = td.cellIndex;
      const rowIndex = td.parentElement ? td.parentElement.rowIndex : -1;
      const rows = table.rows;
      for (let i = rowIndex - 1; i >= 0 && i < rows.length; i--) {
        const c = rows[i] && rows[i].cells[cellIndex];
        if (c && (c.tagName === 'TH' || c.querySelector('th'))) {
          const t = ownText(c);
          if (t) return { text: t, source: 'thead' };
        }
        if (i === 0) break;
      }
    }

    // 再看同行左侧的单元格
    let prev = td.previousElementSibling;
    while (prev) {
      if (prev.tagName === 'TD' || prev.tagName === 'TH') {
        const t = ownText(prev);
        if (t && t.length <= 24) return { text: t, source: 'cell' };
      }
      prev = prev.previousElementSibling;
    }
    return null;
  }

  // ─────────────────────────── 控件收集 ───────────────────────────

  /** 这个控件是不是自定义组件的一部分？ */
  function inWidget(el) {
    try {
      return !!el.closest(WIDGET_SEL);
    } catch (e) {
      return false;
    }
  }

  /** 判断某个控件是否应该被跳过 */
  function shouldSkip(el) {
    if (el.hasAttribute(IGNORE_ATTR)) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;

    // readonly 一般意味着「程序控制的框，别手填」，但自定义组件的内层 input
    // 恰恰都是 readonly——那种要留着，交给自定义组件填充逻辑处理
    if (el.readOnly && !inWidget(el)) return true;

    const type = (el.getAttribute('type') || '').toLowerCase();
    if (SKIP_TYPES.has(type)) return true;

    // 不可见的（display:none / 尺寸为 0）。注意不能用 offsetParent，
    // position:fixed 元素的 offsetParent 是 null 但它是可见的。
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') {
        // 但自定义组件内层的隐藏 input 是正常的，别当成不可见跳过
        if (!inWidget(el)) return true;
      }
    }

    return false;
  }

  // 同理，一个表单里的每个控件都会问一次「这是不是登录表单」
  let loginFormCache = new WeakMap();

  /** 登录表单整个跳过，免得往里填简历 */
  function isLoginForm(el) {
    const form = el.closest('form');
    if (!form) return false;
    const cached = loginFormCache.get(form);
    if (cached !== undefined) return cached;
    const result = !!form.querySelector('input[type=password]');
    loginFormCache.set(form, result);
    return result;
  }

  /** 单个控件的 kind 判定 */
  function kindOf(el) {
    const tag = el.tagName;
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textarea';
    if (el.isContentEditable) return 'contenteditable';
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'radio') return 'radio';
    if (type === 'checkbox') return 'checkbox';
    return 'text';
  }

  /** 采集一个控件的全部信号 */
  function collectSignals(el, extra = {}) {
    const label = resolveLabel(el) || cellText(el) || geometricNeighbor(el);

    // 邻近文本：容器文本 + 前一个兄弟文本，作为弱信号
    const nearby = [];
    const item = formItemContainer(el);
    if (item) {
      const t = ownText(item);
      if (t) nearby.push(t);
    }
    let prev = el.previousElementSibling;
    let hops = 0;
    while (prev && hops < 3) {
      const t = ownText(prev);
      if (t && t.length <= 24) nearby.push(t);
      prev = prev.previousElementSibling;
      hops++;
    }

    const placeholder = el.getAttribute('placeholder') || '';

    return {
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase().replace(/^section-/, ''),
      name: stripDynamicTokens(el.getAttribute('name') || ''),
      id: stripDynamicTokens(el.getAttribute('id') || ''),
      labelText: label ? label.text : '',
      labelSource: label ? label.source : 'none',
      placeholder,
      placeholderIsValueLike: isValueLikePlaceholder(placeholder),
      placeholderIsDescriptive: isDescriptivePlaceholder(placeholder),
      ariaLabel: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      inputType: (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase(),
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      className: stripDynamicTokens(el.getAttribute('class') || ''),
      nearbyText: nearby,
      ...extra,
    };
  }

  /** 把一组 radio/checkbox 合成一个描述符 */
  function groupDescriptor(inputs) {
    const first = inputs[0];
    const opts = inputs.map((inp) => {
      const lbl = resolveLabel(inp) || cellText(inp);
      return { el: inp, text: lbl ? lbl.text : (inp.value || '') };
    });
    const signals = collectSignals(first, {
      groupName: first.name,
      optionTexts: opts.map((o) => o.text),
    });
    // 组级标签经常挂在组容器上而不是某个选项上
    if (!signals.labelText) {
      const group = first.closest('[class*="form-item"],[class*="field"],fieldset') ||
        first.parentElement;
      if (group) {
        const t = ownText(group);
        if (t && t.length <= 30) signals.labelText = t;
      }
    }
    return {
      el: first,
      els: inputs,
      options: opts,
      kind: first.type === 'radio' ? 'radio-group' : 'checkbox-group',
      signals,
    };
  }

  /**
   * 扫描整个文档（或指定根节点），返回字段描述符数组。
   * radio/checkbox 会按 name 分组合并成一个描述符。
   */
  function collectFields(rootEl = document) {
    // DOM 可能在两次扫描之间被重建过（比如点了「添加」按钮），
    // 缓存的位置信息一律作废，否则会拿到已经被移除的节点
    containerCache = new WeakMap();
    loginFormCache = new WeakMap();

    const out = [];
    const all = rootEl.querySelectorAll('input, select, textarea, [contenteditable="true"]');
    const grouped = new Set();
    const radioGroups = new Map();

    let domIndex = 0;
    for (const el of all) {
      if (grouped.has(el)) continue;
      if (shouldSkip(el)) continue;
      if (isLoginForm(el)) continue;

      const kind = kindOf(el);

      if (kind === 'radio' || kind === 'checkbox') {
        // 按 name 分组（没有 name 的话按父容器分组）
        const key = kind + '::' + (el.name || '') + '::' +
          (el.name ? '' : (el.parentElement ? Array.from(el.parentElement.children).indexOf(el) : ''));
        if (!radioGroups.has(key)) radioGroups.set(key, []);
        radioGroups.get(key).push(el);
        continue;
      }

      const signals = collectSignals(el);

      // 验证码/搜索框直接丢弃
      const probe = N.text(signals.labelText + ' ' + signals.placeholder + ' ' + signals.name);
      const probeSpaced = N.spaced(signals.labelText + ' ' + signals.placeholder + ' ' + signals.name);
      if (N.anyMatch(JUNK_ALIASES, probe, probeSpaced)) continue;

      out.push({ el, els: [el], kind, domIndex: domIndex++, signals });
    }

    for (const inputs of radioGroups.values()) {
      const visible = inputs.filter((i) => !shouldSkip(i));
      if (!visible.length) continue;
      for (const i of visible) grouped.add(i);
      const d = groupDescriptor(visible);
      d.domIndex = domIndex++;
      const probe = N.text(d.signals.labelText + ' ' + d.signals.name);
      if (N.anyMatch(JUNK_ALIASES, probe, N.spaced(d.signals.labelText + ' ' + d.signals.name))) {
        continue;
      }
      out.push(d);
    }

    out.sort((a, b) => a.domIndex - b.domIndex);
    return out;
  }

  RA.scan = {
    collectFields,
    collectSignals,
    resolveLabel,
    formItemContainer,
    ownText,
    stripDynamicTokens,
    isValueLikePlaceholder,
    shouldSkip,
    kindOf,
    inWidget,
    WIDGET_SEL,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
