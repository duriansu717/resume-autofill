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

  // 注意：不要跳过 type=search。有些联想输入（学校 / 公司名称）就用
  // type=search 实现，真正的站点搜索框靠下面的 JUNK_ALIASES 拦。
  const SKIP_TYPES = new Set([
    'hidden', 'submit', 'button', 'reset', 'image', 'file', 'password',
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
    '.ant-select', '.ant-picker', '.ant-cascader', '.ant-tree-select', '.ant-auto-complete',
    '.el-select', '.el-date-editor', '.el-cascader', '.el-time-picker', '.el-autocomplete',
    '.ivu-select', '.ivu-date-picker', '.ivu-cascader',
    '.van-field', '.arco-select', '.arco-picker', '.arco-cascader',
    '.arco-tree-select', '.arco-auto-complete', '.semi-select',
    '.n-select', '.n-base-selection', '.t-select', '.t-cascader', '.t-auto-complete',
    '.select2-container', '.chosen-container', '.selectize-control',
    // 小米网申用的 atsx 系列（Ant Design 同构命名）
    '.atsx-select', '.atsx-date-picker', '.atsx-calendar-picker', '.atsx-picker',
    // Ant Design v3 的日期 / 级联选择器（网易等站点仍在使用）
    '.ant-calendar-picker', '.ant-calendar', '.ant-cascader-picker',
    '[class*="calendar"]',
    '[class*="date-picker"]', '[class*="picker-period"]',
    '[role="combobox"]', '[aria-haspopup="listbox"]', '[aria-haspopup="dialog"]',
    '[aria-autocomplete]', '[data-popper-placement]',
  ].join(',');

  /** 疑似验证码 / 搜索框，不要填 */
  const JUNK_ALIASES = ['验证码', '短信验证码', '图形验证码', 'captcha', 'verifycode', 'search', '搜索', '查询', 'keyword'];

  /**
   * 标签本身就是一个简历字段吗？
   *
   * 用来区分「站点的搜索框」和「可搜索的下拉框」：
   * 后者经常写「请输入关键字搜索」，但它的标签是「专业」「学校名称」，
   * 属于正经表单字段，不能因为 placeholder 里有「搜索」就被丢掉。
   * 真正的站点搜索框一般没有表单标签（最多写个「搜索」）。
   */
  function labelLooksLikeField(labelText) {
    if (!labelText) return false;
    const defs = (RA.fields && RA.fields.DEFS) || [];
    if (!defs.length) return false;

    const norm = N.text(labelText);
    const spaced = N.spaced(labelText);
    if (!norm) return false;

    for (const def of defs) {
      if (N.bestMatch(def.aliases, norm, spaced)) return true;
      if (N.bestMatch(def.generic, norm, spaced)) return true;
    }
    return false;
  }

  /** 验证码 / 站点搜索框：丢弃 */
  function isJunk(signals) {
    const all = [signals.labelText, signals.placeholder, signals.name, signals.id].join(' ');
    const norm = N.text(all);
    const spaced = N.spaced(all);
    if (!N.anyMatch(JUNK_ALIASES, norm, spaced)) return false;
    // 标签明确指向简历字段时放行（可搜索下拉的常见写法）
    if (labelLooksLikeField(signals.labelText)) return false;
    return true;
  }

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

    // 日期/时间类提示是标签，不是「示例值」。
    // 「入校时间」只有 4 个汉字，早先会被下面的纯汉字规则误判成示例值。
    if (/(日期|时间|年份|年月|生日|出生|yyyy|mm-dd|yyyy-mm)/i.test(s)) return false;
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

  /**
   * 这个元素本身是不是「表单项容器」。
   *
   * 不能用 [class*="form-item"]：form-item-children / form-item-control /
   * form-item__label 这些子部件全都包含这串字符，会被误判成表单项，
   * 结果真正的 <label> 永远读不到（atsx-form-item-children 就是这种）。
   * 这里按 class token 精确判断，并排除已知的子部件。
   */
  function isFormItemNode(node) {
    if (!node || !node.matches) return false;
    try {
      if (node.matches('li, dd, td')) return true;

      const raw = String(node.className && node.className.baseVal != null
        ? node.className.baseVal : node.className || '');
      if (!raw) return false;

      // BEM 的下划线统一成连字符：el-form-item__label → el-form-item-label
      const tokens = raw.replace(/_+/g, '-').toLowerCase().split(/\s+/);

      const isItem = tokens.some((t) =>
        t === 'form-item' || t === 'formitem' || t === 'form-group' || t === 'formgroup' || t === 'field' ||
        t.endsWith('-form-item') || t.endsWith('-formitem') ||
        t.endsWith('-form-group') || t.endsWith('-formgroup') ||
        t.endsWith('-field'));
      if (!isItem) return false;

      const isSubPart = tokens.some((t) =>
        /(^|-)(form-item|formitem|field)-(children|child|control|label|wrapper|wrap|content|explain|extra|error|validate)(-|$)/.test(t));
      return !isSubPart;
    } catch (e) {
      return false;
    }
  }

  // 每个控件会被反复问「你的表单项容器是谁」（解析标签、取邻近文本、区块投票都要用）。
  // 每次都沿祖先链做 querySelectorAll 在大页面上开销可观，缓存一下。
  let containerCache = new WeakMap();

  /** 往上找最近的「表单项容器」——一个包含本控件、且不带其他控件的祖先 */
  function formItemContainer(el, maxDepth = 8) {
    const cached = containerCache.get(el);
    if (cached !== undefined) return cached;

    let node = el.parentElement;
    let fallback = el.parentElement;
    let found = null;
    for (let i = 0; i < maxDepth && node && node !== document.body; i++) {
      const controls = node.querySelectorAll('input:not([type=hidden]),select,textarea');

      // 只含一个控件的最近祖先：既是标签来源，也是日期组检测的边界
      if (controls.length === 1) fallback = node;

      if (isFormItemNode(node)) {
        // 日期区间、单选组这类表单项里有 2~3 个控件，不能因为「不止一个控件」
        // 就跳过它——真正的「起止时间」标签往往挂在整行的 form-item 上。
        // 只要它自己带 label，就认它。
        const hasLabel = !!(node.querySelector(
          '.ant-form-item-label, .el-form-item__label, .ivu-form-item-label, ' +
          '.van-field__label, .atsx-form-item-label, ' +
          '[class*="form-item-label"], [class*="form-item__label"], ' +
          '[class*="form-label"], [class*="field-label"]'
        ));
        if (controls.length === 1 || hasLabel) { found = node; break; }
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
      '.van-field__label, .atsx-form-item-label, ' +
      '[class*="form-item-label"], [class*="form-item__label"], ' +
      '[class*="form-label"], [class*="field-label"]'
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

  // 日期控件的占位符经常是「YYYY - MM」「YYYY-MM-DD」这种纯格式串，
  // 也属于「点开才让选」的选择器，不能因为 readonly 就直接跳过。
  const PICKER_HINT_RE = /请选择|请选取|选择|搜索|请输入|select|search|picker|choose|yyyy|yyyy-mm|mm-dd|年|月|日|日期|时间/i;

  /**
   * readonly 的框里，有一部分其实是「点一下才弹出面板」的选择器
   * （学校、公司、城市这类往往没有约定类名，光看 class 认不出来）。
   * 它们有明显的提示语，可以据此放行；真正的只读计算字段不会有这种提示。
   */
  function looksLikePicker(el) {
    if (el.getAttribute('aria-autocomplete')) return true;
    if (el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded')) return true;
    const hint = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('title') || '');
    return PICKER_HINT_RE.test(hint);
  }

  /** 判断某个控件是否应该被跳过 */
  function shouldSkip(el) {
    if (el.hasAttribute(IGNORE_ATTR)) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;

    // readonly 一般意味着「程序控制的框，别手填」，但自定义组件的内层 input
    // 恰恰都是 readonly——那种要留着，交给自定义组件填充逻辑处理。
    // 认不出容器的选择器再看提示语放行（学校名称这类常见没有规范类名）。
    if (el.readOnly && !inWidget(el) && !looksLikePicker(el)) return true;

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

    // 原生 <select> 的选项也要收进来——枚举指纹和「按选项值反推字段」
    // 都靠它。早先只有单选组收集了 optionTexts，原生下拉整个漏掉了。
    const optionTexts = el.tagName === 'SELECT' && el.options
      ? Array.from(el.options).slice(0, 60)
        .map((o) => (o.textContent || '').trim())
        .filter(Boolean)
      : [];

    // 组件内部存值用的 0×0 input（atsx-date-picker-period-hidden-input 这类）。
    // 不参与匹配（它旁边可见的选择器才是要填的），但要留在诊断报告里——
    // 认不出来的日期控件，往往就是靠它的容器结构定位的。
    let hiddenInternal = false;
    try {
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height &&
          /hidden/i.test(el.getAttribute('class') || '')) {
        hiddenInternal = true;
      }
    } catch (e) { /* 忽略 */ }

    return {
      hiddenInternal,
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
      optionTexts,
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

      // 验证码/搜索框直接丢弃；标签是简历字段的可搜索下拉要留下
      if (isJunk(signals)) continue;

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
    isFormItemNode,
    ownText,
    stripDynamicTokens,
    isValueLikePlaceholder,
    shouldSkip,
    kindOf,
    inWidget,
    looksLikePicker,
    isJunk,
    labelLooksLikeField,
    WIDGET_SEL,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
