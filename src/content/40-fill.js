/**
 * 填充器：把值真正写进控件里。
 *
 * 这个文件里有两处「不做就填不进去」的关键细节：
 *
 *   1. React 受控组件。直接 el.value = x 会被 React 的 _valueTracker
 *      认为是「没变化」，onChange 不触发，提交时值是空的。
 *      必须先绕过原型 setter 写值，再把 tracker 的旧值回填，
 *      让 React 察觉差异。这是 React Testing Library 内部用的同一套写法。
 *
 *   2. blur 事件不冒泡。站点的委托式校验监听的是 focusout，
 *      派发 blur 事件根本到不了它那儿。
 */
(function (root) {
  'use strict';

  const RA = root.RA;
  const N = RA.normalize;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function withTimeout(promise, ms, fallback = null) {
    return Promise.race([
      promise,
      new Promise((r) => setTimeout(() => r(fallback), ms)),
    ]);
  }

  /** 轮询等待某个条件成立，超时返回 null。绝不无限等待。 */
  function waitFor(predicate, timeout = 700, interval = 30) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let r = null;
        try {
          r = predicate();
        } catch (e) {
          r = null;
        }
        if (r) return resolve(r);
        if (Date.now() - start >= timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  // ─────────────────────── 撤销栈 ───────────────────────

  const undoStack = [];

  function record(el, kind, previous, extra = {}) {
    undoStack.push({ el, kind, previous, ...extra });
  }

  /** 还原一条记录。尽力而为，单个失败不影响其余。 */
  function undoOne(item) {
    try {
      const { el, kind, previous } = item;
      if (!el || !el.isConnected) return false;

      if (kind === 'radio-group' || kind === 'checkbox-group') {
        // previousMap 是 [[元素, 是否选中]] 数组。这里必须用数组而不是对象，
        // 对象键会把 DOM 元素强制转成字符串，恢复时就找不回来了。
        for (const [node, wasChecked] of item.previousMap || []) {
          // 走 setNativeChecked 而不是直接赋 checked，
          // 这样撤销也会通知框架，否则页面状态和视觉状态会不一致
          if (node && node.isConnected) setNativeChecked(node, wasChecked);
        }
        return true;
      }

      if (kind === 'contenteditable') {
        el.textContent = previous == null ? '' : previous;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }

      setNativeValue(el, previous == null ? '' : previous);
      return true;
    } catch (e) {
      return false;
    }
  }

  function undoAll() {
    let n = 0;
    while (undoStack.length) {
      if (undoOne(undoStack.pop())) n++;
    }
    // 清理填充时打上的高亮
    if (RA.overlay && RA.overlay.clearMarks) RA.overlay.clearMarks();
    return n;
  }

  /** 只撤销最近一次写入——手动一个个填的时候，一键全撤太重了 */
  function undoLast() {
    while (undoStack.length) {
      const item = undoStack.pop();
      if (undoOne(item)) return { ok: true, el: item.el };
    }
    return { ok: false };
  }

  // ─────────────────────── 核心写值 ───────────────────────

  /**
   * 绕过框架、把值真正写进 DOM 并让框架感知到。
   * @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} el
   * @param {string} value
   */
  function setNativeValue(el, value, opts = {}) {
    const strValue = value == null ? '' : String(value);

    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;

    const prev = el.value;
    if (prev === strValue && !opts.force) return true;

    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, strValue);
    else el.value = strValue;

    // React 的实例级 value tracker：不把它「骗」一下，React 会认为值没变
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      try {
        tracker.setValue(prev);
      } catch (e) {
        /* 不同 React 版本内部结构有差异，失败也不致命 */
      }
    }

    if (!opts.silent) {
      try {
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, composed: true, inputType: 'insertText', data: strValue,
        }));
      } catch (e) {
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
    return true;
  }

  /**
   * 单选/复选框专用：有意义的状态是 checked，不是 value。
   *
   * 这里不能走 setNativeValue —— 那个函数写的是 value 属性，
   * 而单选按钮的 value 是固定不变的（"男"/"女"），所以「值没变就早退」
   * 的条件永远成立，一个事件都发不出来。必须对 checked 做同样的一套：
   * 绕过原型 setter 写值 + 推回 React 的 tracker + 派发事件。
   */
  function setNativeChecked(el, checked) {
    const prev = el.checked;
    if (prev === checked) return true;

    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (desc && desc.set) desc.set.call(el, checked);
    else el.checked = checked;

    // React 用 _valueTracker 跟踪 radio/checkbox，推回旧值才能让它察觉变化
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      try {
        tracker.setValue(prev ? el.value : '');
      } catch (e) { /* 内部结构随版本变化，失败不致命 */ }
    }

    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  }

  /** focusout 才冒泡；站点监听的是它 */
  function triggerBlur(el) {
    try {
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    } catch (e) {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
    if (typeof el.blur === 'function') el.blur();
  }

  // ─────────────────────── 值归一与枚举别名 ───────────────────────

  /**
   * 中文下拉框里的选项文字和简历里写的值经常不是一回事：
   * 简历写「本科」，选项是「大学本科」；简历写「男」，选项是「男性」。
   * 这里给出常见枚举的显式对应，相似度匹配搞不定的靠它兜。
   */
  const VALUE_ALIASES = {
    'basic.gender': {
      男: ['男', '男性', 'male', 'M'],
      女: ['女', '女性', 'female', 'F'],
    },
    'educations.degree': {
      高中: ['高中', '普通高中', '高中毕业'],
      中专: ['中专', '中等专业学校'],
      大专: ['大专', '专科', '高职', '大学专科'],
      本科: ['本科', '大学本科', '学士', '全日制本科', '本科毕业'],
      硕士: ['硕士', '硕士研究生', '研究生', '硕士学位'],
      博士: ['博士', '博士研究生', '博士学位'],
    },
    'basic.maritalStatus': {
      未婚: ['未婚', '单身'],
      已婚: ['已婚'],
    },
    'basic.politicalStatus': {
      中共党员: ['中共党员', '党员', '中国共产党党员'],
      共青团员: ['共青团员', '团员'],
      群众: ['群众', '普通群众'],
    },
    'jobIntention.jobType': {
      全职: ['全职', '全日制', '全时'],
      实习: ['实习', '实习生'],
      兼职: ['兼职'],
    },
  };

  /** 把简历里的值展开成一组可接受的写法，用于和选项文字比对 */
  function valueVariants(key, value) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return [];
    const table = VALUE_ALIASES[key];
    if (!table) return [v];
    for (const canonical of Object.keys(table)) {
      const variants = table[canonical];
      if (variants.some((x) => N.text(x) === N.text(v) || N.text(v).includes(N.text(x)))) {
        return variants.concat([v]);
      }
    }
    return [v];
  }

  // ─────────────────────── 各类控件的写法 ───────────────────────

  // 前缀匹配，不要用 ^...$ —— 选项文字经常是「请选择学历」这种带后缀的
  const PLACEHOLDER_OPTION_RE = /^(请选择|请选中|请选取|请填写|暂无|please\s*select|select\s*\.{0,3}|-{2,}|—{2,})/i;

  function isPlaceholderOption(o) {
    const v = (o.value || '').trim();
    const t = (o.textContent || '').trim();
    // 只认明确的占位值。早先这里把 value="0" 也当占位，会误伤
    // 「0 年经验」「0 次」这类合法选项。
    if (v === '' || v === '-1') return true;
    return PLACEHOLDER_OPTION_RE.test(t);
  }

  /**
   * 下拉框按「选项文字」匹配，不能只比 value——value 经常是 1/2/3 这种无意义编号。
   *
   * 这里绝对不要先写 sel.value 再调 setNativeValue：
   * setNativeValue 开头有 `prev === strValue 就早退` 的判断，先写会让它直接返回，
   * 结果 input/change 一个都不发、React 的 tracker 也不会被推回旧值。
   * 表现就是「界面上选中了，提交时是空的」——这个坑踩过一次，别再加回来。
   */
  function selectByText(sel, variants) {
    const opts = Array.from(sel.options).filter((o) => !o.disabled && !isPlaceholderOption(o));
    if (!opts.length) return false;

    let best = null;
    let bestScore = 0;

    for (const target of variants) {
      const tn = N.text(target);
      if (!tn) continue;
      for (const o of opts) {
        const cands = [N.text(o.textContent), N.text(o.value), N.text(o.label || '')];
        for (const c of cands) {
          if (!c) continue;
          let s = 0;
          if (c === tn) s = 1;
          else if (c.includes(tn) || tn.includes(c)) {
            s = 0.75 + 0.25 * (Math.min(c.length, tn.length) / Math.max(c.length, tn.length));
          }
          if (s > bestScore) {
            bestScore = s;
            best = o;
          }
        }
      }
    }

    if (!best || bestScore < 0.6) return false;
    // 只走 setNativeValue：它用原型上的 setter 选中选项，并负责派发事件
    return setNativeValue(sel, best.value);
  }

  /** radio / checkbox 组：按选项文字点选 */
  function fillChoiceGroup(d, variants) {
    const opts = d.options || [];
    let best = null;
    let bestScore = 0;

    for (const target of variants) {
      const tn = N.text(target);
      if (!tn) continue;
      for (const o of opts) {
        const on = N.text(o.text);
        if (!on) continue;
        let s = 0;
        if (on === tn) s = 1;
        else if (on.includes(tn) || tn.includes(on)) {
          s = 0.75 + 0.25 * (Math.min(on.length, tn.length) / Math.max(on.length, tn.length));
        }
        if (s > bestScore) {
          bestScore = s;
          best = o;
        }
      }
    }

    if (!best || bestScore < 0.6) return false;

    // 用数组记录而不是对象——对象键会把 DOM 元素转成字符串
    const previousMap = opts.map((o) => [o.el, o.el.checked]);

    try {
      best.el.click(); // 优先用 click，框架监听的是完整合成事件链
    } catch (e) {
      setNativeChecked(best.el, true);
    }
    // click 没能选中（元素被遮挡、被 label 拦截等），退回直接写 checked
    if (!best.el.checked) setNativeChecked(best.el, true);

    return { ok: true, previousMap };
  }

  /** 拆分日期：把 {y,m,d} 分发给年/月/日三个控件 */
  function fillDateCluster(cluster, parts) {
    if (!parts || !parts.y) return false;
    let allOk = true;

    for (const u of cluster.units) {
      const el = u.el;
      let val = null;

      if (u.unit === 'Y') val = String(parts.y);
      else if (u.unit === 'M') val = parts.m != null ? N.pad2(parts.m) : null;
      else if (u.unit === 'D') val = parts.d != null ? N.pad2(parts.d) : null;

      if (val == null) continue; // 简历里只有年月，日这格就留空

      const isSelect = el.tagName === 'SELECT';
      record(el, isSelect ? 'select' : 'text', el.value);

      if (isSelect) {
        // 年份下拉可能写 '2020' 也可能写 '2020年'
        const ok = selectByText(el, [val, val + '年', val + '月', val + '日', String(+val)]);
        if (!ok) allOk = false;
      } else {
        setNativeValue(el, val);
        triggerBlur(el);
      }
    }
    return allOk;
  }

  /** 只读输入框的前置处理——有些日期控件是 readonly，得先摘掉再写 */
  function unwrapReadonly(el) {
    if (!el.readOnly) return () => {};
    const had = el.getAttribute('readonly');
    el.removeAttribute('readonly');
    return () => { if (had != null) el.setAttribute('readonly', had); };
  }

  // ─────────────────────── 自定义组件（尽力而为） ───────────────────────

  /**
   * 弹层里按文字找选项点击。
   * 只认 role=option / 常见的框架选项类名，并且把过长的文字排除掉
   * （菜单里经常混着整段说明文字）。
   */
  const OPTION_SEL = '[role="option"], .ant-select-item-option, .el-select-dropdown__item, ' +
    '.ivu-select-item, .ant-cascader-menu-item, .el-cascader-node, ' +
    '.ant-picker-cell, .el-date-table td, li[class*="option"]';

  function clickOptionIn(scope, variants) {
    const items = Array.from(scope.querySelectorAll(OPTION_SEL)).filter((it) => {
      const t = (it.textContent || '').trim();
      return t && t.length <= 40;
    });

    // 兜底：有些组件的选项没有任何 role / 约定类名，只是一串 div / li / span。
    // 找「叶子节点」——文字在它这里结束，点击会冒泡到真正挂事件的父节点。
    if (!items.length) {
      for (const el of scope.querySelectorAll('div, li, span, td, a')) {
        if (el.children.length) continue;
        const t = (el.textContent || '').trim();
        if (t && t.length <= 40) items.push(el);
      }
    }

    if (!items.length) return null;

    let best = null;
    let bestScore = 0;
    for (const target of variants) {
      const tn = N.text(target);
      if (!tn) continue;
      for (const it of items) {
        const on = N.text(it.textContent);
        if (!on) continue;
        let s = on === tn ? 1
          : (on.includes(tn) || tn.includes(on))
            ? 0.75 + 0.25 * (Math.min(on.length, tn.length) / Math.max(on.length, tn.length))
            : 0;
        if (s > bestScore) { bestScore = s; best = it; }
      }
    }
    if (!best || bestScore < 0.6) return null;

    try { best.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 忽略 */ }

    // 不少组件把选中逻辑挂在 mousedown 上（为了抢在 blur 之前），
    // 只派发 click 会被它们忽略。
    try {
      best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    } catch (e) { /* 忽略 */ }

    best.click();
    return best;
  }

  /** 当前所有「看得见」的下拉面板 */
  function visibleDropdowns() {
    const sel = '[role="listbox"], [role="menu"], ' +
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden), ' +
      '.el-select-dropdown, .ivu-select-dropdown, .ant-picker-panel, ' +
      '.ant-cascader-dropdown, .el-cascader-panel, [class*="dropdown"]';

    const out = [];
    for (const p of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      if (!p.getClientRects().length) continue; // 没有尺寸的占位元素
      out.push(p);
    }
    return out;
  }

  /** 让下拉/日期弹层弹出来 */
  function openWidget(host) {
    const trigger = host.querySelector(
      '[role="combobox"], [aria-haspopup="listbox"], .ant-select-selector, ' +
      '.el-input__inner, .ivu-select-selection, .ant-picker, .el-range-input'
    ) || host;
    // 有些实现监听 mousedown 而不是 click
    try {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    } catch (e) { /* 忽略 */ }
    try {
      trigger.click();
    } catch (e) { /* 忽略 */ }
    if (typeof trigger.focus === 'function') trigger.focus();
    return trigger;
  }

  /** 这些字段的值是日期：控件不一定带 date 类名，靠 key 判断更稳 */
  function isDateKey(key) {
    if (!key) return false;
    return /(^|\.)(birthday|startDate|endDate|date)$/.test(key);
  }

  /** 显示值里有没有这个年月（兼容 2021-07 / 2021年7月 / 2021/07/01 等写法） */
  function dateShown(shown, iso) {
    if (!shown) return false;
    const y = iso.slice(0, 4);
    const m = iso.slice(5, 7);
    if (!shown.includes(y)) return false;
    return shown.includes(m) || shown.includes(String(Number(m)));
  }

  function closePanel(trigger) {
    try {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 日期控件：优先「打字 + 回车」。
   * YYYY-MM 和 YYYY-MM-DD 互相回退——月份选择器只认前者，日期选择器一般要后者。
   */
  async function typeDate(host, input, variants) {
    const iso = variants.find((v) => /^\d{4}-\d{2}(-\d{2})?$/.test(v));
    if (!iso) return null;

    const candidates = [iso];
    if (/^\d{4}-\d{2}$/.test(iso)) candidates.push(iso + '-01');
    else candidates.push(iso.slice(0, 7));

    const restore = unwrapReadonly(input);
    record(input, 'text', input.value);

    try {
      for (const v of candidates) {
        setNativeValue(input, v);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        await sleep(150);

        const confirmBtn = host.querySelector('button[class*="ok"], .ant-picker-ok button');
        if (confirmBtn) confirmBtn.click();
        await sleep(130);

        // 控件显示出来的可能是本地化文本（1998年07月15日），不能直接比对原字符串
        const shown = readDisplay(host);
        if (dateShown(shown, v) || sameish(shown, v)) {
          return { ok: true, via: 'date-type', value: shown };
        }
      }
    } finally {
      restore();
    }

    return { ok: false, reason: 'date-not-accepted' };
  }

  /** 弹层/控件里找一个能打字的输入框（可搜索下拉的搜索框） */
  function findTypeableInput(host, panel) {
    const pick = (root) => {
      if (!root || !root.querySelectorAll) return null;
      for (const inp of root.querySelectorAll('input')) {
        const t = (inp.getAttribute('type') || 'text').toLowerCase();
        if (t !== 'text' && t !== 'search') continue;
        if (inp.readOnly || inp.disabled) continue;
        return inp;
      }
      return null;
    };
    // 弹层里的搜索框优先，其次才是控件自身的
    return pick(panel) || pick(host);
  }

  function optionTexts(panel) {
    if (!panel) return [];
    return Array.from(panel.querySelectorAll(OPTION_SEL))
      .slice(0, 30)
      .map((it) => (it.textContent || '').trim());
  }

  function sameTexts(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** 面板可能被组件重渲染成新节点，用之前重新确认一下 */
  function livePanel(panel) {
    if (panel && panel.isConnected) {
      const cs = getComputedStyle(panel);
      if (cs.display !== 'none' && cs.visibility !== 'hidden') return panel;
    }
    const vis = visibleDropdowns();
    return vis.length ? vis[vis.length - 1] : panel;
  }

  /**
   * 可搜索的下拉：列表是虚拟滚动的，不输入就找不到目标项。
   * 往搜索框里打关键字，等列表过滤之后再点。
   *
   * 两个细节：
   *   · 输入之后组件可能把面板整个换成新节点，所以点之前重新取一次
   *   · 列表完全没变化说明这个输入框不是搜索框，别再打了
   *   · 失败时把输入框恢复原样，不能直接清空——有的组件里它就是显示值
   */
  async function typeToFilter(host, panel, variants) {
    const input = findTypeableInput(host, panel);
    if (!input) return false;

    const original = input.value;
    const beforeTexts = optionTexts(panel);

    for (const v of variants) {
      if (!v) continue;
      const probe = v.length > 8 ? v.slice(0, 8) : v;
      try { setNativeValue(input, probe); } catch (e) { continue; }

      try {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
      } catch (e) { /* 忽略 */ }

      await sleep(180);

      const fresh = livePanel(panel);
      if (clickOptionIn(fresh, variants)) return true;

      if (sameTexts(beforeTexts, optionTexts(fresh))) break;
    }

    try { setNativeValue(input, original); } catch (e) { /* 忽略 */ }
    return false;
  }

  /** 级联面板（省 → 市 → 区）：逐列点，点完一列下一列才会出现 */
  async function clickCascader(panel, path) {
    let any = false;

    for (const part of path) {
      if (!part) break;

      const cols = panel.querySelectorAll('.ant-cascader-menu, .el-cascader-menu');
      const scope = cols.length ? cols[cols.length - 1] : panel;
      const hit = clickOptionIn(scope, [String(part)]);
      if (!hit) break;

      any = true;
      await sleep(200);
    }

    return any;
  }

  /**
   * 自定义组件填充。识别不出就放弃并如实报告——
   * 卡住整个流程比填不上一个字段糟糕得多。
   *
   * ctx 是字段描述符（可选）。带上 raKey / regionPath 之后能多处理两种形态：
   *   · 日期控件：按字段 key 判断，不依赖类名
   *   · 省市区级联树：按 省 → 市 → 区 逐列点击
   */
  async function customWidget(host, variants, originalEl, ctx) {
    const before = readDisplay(host);
    const key = ctx && ctx.raKey;

    // 1) 内层藏着一个真 <select>（不少站点保留隐藏 select 做表单提交）
    const inner = host.querySelector('select');
    if (inner && inner.options.length > 1) {
      record(inner, 'select', inner.value);
      return selectByText(inner, variants) ? { ok: true, via: 'inner-select' } : { ok: false, reason: 'inner-select-no-match' };
    }

    // 2) 日期类控件优先「打字」而不是「点日历格子」——点格子依赖本地化和虚拟滚动，太脆
    const dateInput = host.querySelector('input');
    const isDateWidget = dateInput && (
      /(ant-picker|el-date-editor|date)/i.test(host.className + ' ' + dateInput.className) ||
      isDateKey(key)
    );

    if (isDateWidget) {
      const r = await typeDate(host, dateInput, variants);
      if (r && r.ok) return r;
      // 打不进去就继续走弹层路径，看看能不能点格子
    }

    // 3) 通用：点开 → 等弹层
    // 先记下点开之前已经开着的面板，等下优先挑「新出现」的那个。
    // 页面上同时挂着好几个下拉时，取第一个会点错地方。
    const beforePanels = visibleDropdowns();
    const trigger = openWidget(host);

    const panel = await waitFor(() => {
      const vis = visibleDropdowns();
      if (!vis.length) return null;

      for (let i = vis.length - 1; i >= 0; i--) {
        if (beforePanels.indexOf(vis[i]) < 0) return vis[i];
      }
      return vis[vis.length - 1];
    }, 700);

    if (!panel) {
      return { ok: false, reason: 'panel-not-opened' };
    }

    // 面板出现 ≠ 选项渲染完了——很多站点的选项是异步拉取的
    await waitFor(() => panel.querySelector(OPTION_SEL) || null, 800);

    // 3.1) 省市区级联树：面板里是多列，按 省 → 市 → 区 逐列点
    const isCascader = /cascader/i.test(String(panel.className || '')) ||
      !!panel.querySelector('.ant-cascader-menu, .el-cascader-menu');
    const regionPath = (ctx && Array.isArray(ctx.regionPath)) ? ctx.regionPath : null;

    if (isCascader && regionPath && regionPath.filter(Boolean).length >= 2) {
      const ok = await clickCascader(panel, regionPath);
      await sleep(140);

      const after = readDisplay(host);
      if (ok && after !== before) return { ok: true, via: 'cascader', value: after };

      closePanel(trigger);
      return { ok: false, reason: 'cascader-not-matched' };
    }

    // 3.2) 普通下拉：先直接点，点不到再输入关键字过滤（可搜索下拉）
    let clicked = clickOptionIn(panel, variants);
    if (!clicked) {
      clicked = await typeToFilter(host, panel, variants);
    }
    if (!clicked) {
      // 列表可能刚加载完，再给一次机会
      await sleep(250);
      clicked = clickOptionIn(panel, variants);
    }

    await sleep(120);

    if (!clicked) {
      // 关掉弹层，免得挡住用户视线
      closePanel(trigger);
      return { ok: false, reason: 'option-not-found' };
    }

    const after = readDisplay(host);
    return { ok: after !== before, via: 'click-recipe', value: after };
  }

  /** 读自定义组件当前显示的文字 */
  function readDisplay(host) {
    const inp = host.querySelector('input');
    if (inp && inp.value) return inp.value;
    const t = (host.textContent || '').trim();
    return t.length <= 60 ? t : '';
  }

  // ─────────────────────── 主写入流程 ───────────────────────

  function readBack(d) {
    if (d.kind === 'radio-group' || d.kind === 'checkbox-group') {
      const checked = (d.options || []).filter((o) => o.el.checked).map((o) => o.text);
      return checked.join(' / ');
    }
    if (d.kind === 'date-cluster') {
      return d.cluster.units.map((u) => u.el.value).join('-');
    }
    return d.el.value;
  }

  /** 值是不是「写进去了」——容错比对，避免格式微差被误判为失败 */
  function sameish(a, b) {
    const x = N.text(a);
    const y = N.text(b);
    if (!x) return false;
    if (x === y) return true;
    return x.includes(y) || y.includes(x);
  }

  /**
   * 往一个控件写值。
   * @returns {Promise<{ok:boolean, reason?:string, via?:string, written:string}>}
   */
  async function writeOne(d, variants, rawValue) {
    const primary = String(rawValue == null ? '' : rawValue);

    try {
      if (typeof d.el.scrollIntoView === 'function') {
        d.el.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    } catch (e) { /* 某些环境下会抛，无所谓 */ }

    let result;

    if (d.kind === 'date-cluster') {
      const parts = N.dateParts(primary);
      if (!parts) return { ok: false, reason: 'bad-date', written: '' };
      // 撤销记录由 fillDateCluster 内部逐格写入，这里不要重复记
      const ok = fillDateCluster(d.cluster, parts);
      result = { ok, reason: ok ? undefined : 'date-part-missing', via: 'date-cluster', written: primary };
    } else if (d.kind === 'select') {
      record(d.el, 'select', d.el.value);
      const ok = selectByText(d.el, variants);
      result = { ok, reason: ok ? undefined : 'no-matching-option', via: 'select', written: primary };
    } else if (d.kind === 'radio-group' || d.kind === 'checkbox-group') {
      const r = fillChoiceGroup(d, variants);
      if (r && r.ok) {
        record(d.el, d.kind, null, { els: d.options.map((o) => o.el), previousMap: r.previousMap });
        result = { ok: true, via: 'click', written: primary };
      } else {
        result = { ok: false, reason: 'no-matching-option', written: primary };
      }
    } else if (d.kind === 'contenteditable') {
      d.el.focus();
      const prev = d.el.textContent;
      record(d.el, 'contenteditable', prev);
      try {
        document.execCommand('insertText', false, primary);
      } catch (e) {
        d.el.textContent = primary;
      }
      d.el.dispatchEvent(new Event('input', { bubbles: true }));
      result = { ok: true, via: 'contenteditable', written: primary };
    } else {
      // 自定义组件：真正干活的是外面那层 div，内层 input 只是摆设
      // （通常 readonly，甚至是零尺寸或 opacity:0）
      let host = null;
      try {
        host = d.el.closest(RA.scan.WIDGET_SEL);
      } catch (e) { /* 选择器不支持就算了 */ }

      const hiddenInput = d.el.readOnly || d.signals.inputType === 'hidden' ||
        getComputedStyle(d.el).opacity === '0' ||
        (d.el.getBoundingClientRect().width === 0 && !!host);

      if (host || hiddenInput) {
        const r = await customWidget(host || d.el.parentElement, variants, d.el, d);
        result = { ok: !!r.ok, reason: r.reason, via: r.via || 'custom', written: primary };
      } else {
        d.el.focus({ preventScroll: true });
        record(d.el, 'text', d.el.value);
        setNativeValue(d.el, primary);
        triggerBlur(d.el);
        result = { ok: true, via: 'native', written: primary };
      }
    }

    // ── 填完复查：框架重渲染经常把值冲掉，必须回读确认 ──
    if (result.ok) {
      await sleep(90);

      // 下拉框单独判断：选中值可能是 "1" 这种编码，跟简历里的文字对不上，
      // 没法直接比对。但必须确认它没被打回「请选择」那个占位项——
      // 否则会报成成功，实际提交时是空的。
      if (d.kind === 'select') {
        const opt = d.el.options[d.el.selectedIndex];
        if (!opt || isPlaceholderOption(opt)) {
          return { ok: false, reason: 'select-reset', written: '' };
        }
        result.actual = opt.textContent.trim();
        return result;
      }

      let now = readBack(d).trim();
      if (!sameish(now, primary) && d.kind !== 'select' && d.kind !== 'date-cluster') {
        // 重试一次
        await sleep(200);
        if (d.kind === 'text' || d.kind === 'textarea') {
          setNativeValue(d.el, primary);
          triggerBlur(d.el);
          await sleep(120);
          now = readBack(d).trim();
        }
      }
      if (!sameish(now, primary) && !now) {
        return { ok: false, reason: 'value-reverted', written: '' };
      }
      result.actual = now;
    }

    return result;
  }

  // ─────────────────────── 从简历里取值 ───────────────────────

  // 数组类的顶层字段名从字段表里取，别手写——之前只写了 educations|works|projects，
  // 实习、证书、语言、获奖、竞赛、校园、培训、学生干部、IT 技能全都取不到值
  const ARRAY_GROUP_RE = new RegExp(
    '^(' + Object.keys(RA.fields.ARRAY_NAME_BY_SECTION)
      .map((k) => RA.fields.ARRAY_NAME_BY_SECTION[k])
      .join('|') + ')\\.(.+)$'
  );

  /**
   * 把 key + 条目下标解析成实际要填的值。
   * 有些字段简历里没写，但能从别的字段推出来（身份证 → 生日/性别，生日 → 年龄）。
   */
  function valueFor(profile, key, entryIndex) {
    if (!profile) return null;

    // 自定义字段：数据存在 profile.custom[字段id] 下
    if (key.indexOf('custom.') === 0) {
      const id = key.slice('custom.'.length);
      const custom = profile.custom;
      const v = custom && typeof custom === 'object' ? custom[id] : null;
      return v == null || v === '' ? null : v;
    }

    const arrMatch = ARRAY_GROUP_RE.exec(key);
    if (arrMatch) {
      const arr = profile[arrMatch[1]];
      const item = Array.isArray(arr) ? arr[entryIndex || 0] : null;
      if (!item) return null;
      const v = item[arrMatch[2]];
      return v == null || v === '' ? null : v;
    }

    const dot = key.indexOf('.');
    if (dot < 0) return null;
    const group = profile[key.slice(0, dot)];
    if (!group || typeof group !== 'object') return null;
    let v = group[key.slice(dot + 1)];

    if (v == null || v === '') {
      // 派生值
      if (key === 'basic.age') {
        const age = RA.storage.deriveAge(profile.basic && profile.basic.birthday);
        return age == null ? null : String(age);
      }
      if (key === 'basic.gender' || key === 'basic.birthday') {
        const d = RA.storage.deriveFromIdCard(profile.basic && profile.basic.idCard);
        if (d) v = d[key === 'basic.gender' ? 'gender' : 'birthday'];
      }
    }

    return v == null || v === '' ? null : v;
  }

  RA.fill = {
    setNativeValue,
    setNativeChecked,
    triggerBlur,
    selectByText,
    fillChoiceGroup,
    fillDateCluster,
    customWidget,
    writeOne,
    valueFor,
    valueVariants,
    isDateKey,
    readBack,
    sameish,
    undoAll,
    undoLast,
    waitFor,
    withTimeout,
    sleep,
    _undoStack: undoStack,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
