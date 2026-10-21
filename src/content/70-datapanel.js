/**
 * 简历数据面板 —— 页面右侧常驻的一张「可点可复制」的简历。
 *
 * 设计出发点：与其让匹配引擎去猜「这个框是什么字段」，不如把简历摊开在页面上，
 * 让用户自己指。引擎负责认识字段，人负责确认对应关系——后者几乎不会出错，
 * 而且出错时用户立刻看得见。
 *
 * 展示结构是三层：模块 → 条目 → 字段。
 *   · 模块（基本信息 / 教育经历 / 工作经历…）可展开收起
 *   · 条目（教育经历 1、教育经历 2…）只在数组类模块里出现
 *   · 字段是真正可点、可复制的那一层
 *
 * 两种用法：
 *   1. 点页面上的输入框 → 再点面板里的数据 → 填进去
 *   2. 点数据右边的「复制」→ 自己去粘贴
 *
 * 填值仍然走 RA.main.fillField，也就是和自动填充同一套写入逻辑
 * （原生 setter + React tracker + focusout），所以受控组件照样能填。
 */
(function (root) {
  'use strict';

  const RA = root.RA;

  let panelEl = null;
  /** 当前模板。数据面板只显示模板里的字段。 */
  let activeTemplate = null;
  /** 当前选中的目标输入框 */
  let targetEl = null;
  /** 已经锁定（点过数据行）等待用户点输入框的那条数据 */
  let armedItem = null;
  let filterText = '';

  /**
   * 哪些模块被用户主动收起了。
   *
   * 用「记录收起」而不是「记录展开」：默认全部展开，用户看到的是一整份简历，
   * 再把不关心的模块折起来。反过来默认收起的话，每次都要先点开才能看到内容。
   */
  const collapsedModules = new Set();

  // ─────────────────────── 数据结构 ───────────────────────

  /**
   * 把简历摊平成「模块 → 条目 → 字段」。
   *
   * @returns {Array<{
   *   key: string,               // 区块 key
   *   title: string,             // 模块显示名
   *   isArray: boolean,          // 是否数组类（教育/工作…）
   *   entries: Array<{ index:number, title:string|null, items:Array }>,
   *   count: number              // 该模块下有效字段总数
   * }>}
   */
  /**
   * @param {Object} profile
   * @param {Object} [template] 当前模板。传了就按模板的分组和字段显示；
   *        没传（或模板是空的）就退回内置全集。
   */
  function buildGroups(profile, template) {
    if (template && Array.isArray(template.groups) && template.groups.length) {
      return buildFromTemplate(profile, template);
    }
    return buildFromDefs(profile);
  }

  /** 按模板渲染：分组、字段、显示名全都听模板的 */
  function buildFromTemplate(profile, template) {
    const groups = [];

    for (const group of template.groups) {
      const arrName = RA.fields.ARRAY_NAME_BY_SECTION[group.sectionKey];
      const entries = [];
      let count = 0;

      const collect = (entryIndex) => {
        const items = [];
        for (const field of group.fields) {
          let v;
          try {
            v = RA.fill.valueFor(profile, field.key, entryIndex);
          } catch (e) {
            v = null;
          }
          if (v == null) continue;
          items.push({
            label: RA.fields.labelOf(field),
            value: String(v),
            key: field.key,
            entryIndex,
          });
        }
        return items;
      };

      if (arrName) {
        const arr = Array.isArray(profile[arrName]) ? profile[arrName] : [];
        arr.forEach((_, i) => {
          const items = collect(i);
          if (!items.length) return;
          count += items.length;
          entries.push({ index: i, title: `${group.title || '自定义分组'} ${i + 1}`, items });
        });
      } else {
        const items = collect(0);
        if (items.length) {
          count = items.length;
          entries.push({ index: 0, title: null, items });
        }
      }

      if (entries.length) {
        groups.push({
          key: group.sectionKey,
          title: group.title,
          isArray: !!arrName,
          entries,
          count,
        });
      }
    }

    return groups;
  }

  /** 没有模板时的兜底：内置字段全上 */
  function buildFromDefs(profile) {
    const bySection = new Map();
    for (const d of RA.fields.DEFS) {
      if (!bySection.has(d.section)) bySection.set(d.section, []);
      bySection.get(d.section).push(d);
    }

    const groups = [];
    for (const [sectionKey, defs] of bySection) {
      const arrName = RA.fields.ARRAY_NAME_BY_SECTION[sectionKey];
      const title = RA.fields.SECTION_LABEL[sectionKey] || sectionKey;
      const entries = [];
      let count = 0;

      if (arrName) {
        const arr = Array.isArray(profile[arrName]) ? profile[arrName] : [];
        arr.forEach((_, i) => {
          const items = collectItems(profile, defs, i);
          if (!items.length) return;
          count += items.length;
          entries.push({ index: i, title: `${title} ${i + 1}`, items });
        });
      } else {
        const items = collectItems(profile, defs, 0);
        if (items.length) {
          count = items.length;
          entries.push({ index: 0, title: null, items });
        }
      }

      if (entries.length) {
        groups.push({ key: sectionKey, title, isArray: !!arrName, entries, count });
      }
    }
    return groups;
  }

  function collectItems(profile, defs, entryIndex) {
    const items = [];
    for (const d of defs) {
      let v;
      try {
        v = RA.fill.valueFor(profile, d.key, entryIndex);
      } catch (e) {
        v = null;
      }
      if (v == null) continue;
      items.push({ label: d.label, value: String(v), key: d.key, entryIndex });
    }
    return items;
  }

  // ─────────────────────── 复制 ───────────────────────

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      // 非安全上下文或没拿到焦点时会失败，走下面的回退
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('data-ra-ignore', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ─────────────────────── 目标选取 ───────────────────────

  function setTarget(node) {
    targetEl = node;
    armedItem = null;
    refreshStatus();

    if (node) {
      try {
        RA.overlay.setHighlight(node.getBoundingClientRect());
      } catch (e) { /* 元素可能已经不在文档里 */ }
      RA.overlay.showToast('已选中输入框，现在点右侧的数据');
    }
  }

  function clearTarget() {
    targetEl = null;
    armedItem = null;
    RA.overlay.clearHighlight();
    refreshStatus();
  }

  function startPicking() {
    RA.pick.start(onFieldPicked);
    refreshStatus();
  }

  /** 反向顺序也支持：先点数据，再点输入框 */
  function armItem(item) {
    armedItem = item;
    targetEl = null;
    refreshStatus();
    RA.overlay.showToast(`已选定「${item.label}」，现在点页面上的输入框`);
    RA.pick.start(onFieldPicked);
  }

  function onFieldPicked(node) {
    if (armedItem) {
      doFill(node, armedItem);
      armedItem = null;
      refreshStatus();
    } else {
      setTarget(node);
    }
  }

  // ─────────────────────── 填充 ───────────────────────

  async function doFill(node, item) {
    let res;
    try {
      res = await RA.main.fillField(node, item.key, item.entryIndex, { quiet: true });
    } catch (e) {
      res = { ok: false, reason: String(e && e.message) };
    }

    if (res && res.ok) {
      RA.overlay.showToast(`已填入「${item.label}」：${String(item.value == null ? '' : item.value).slice(0, 30)}`);
      try {
        RA.overlay.clearMarks();
        RA.overlay.markField(node, 'high');
      } catch (e) { /* 忽略 */ }
    } else {
      RA.overlay.showToast(`写入失败（${(res && res.reason) || '未知原因'}）`);
    }
    refreshStatus();
  }

  // ─────────────────────── 渲染 ───────────────────────

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  /**
   * 估算一段文字显示出来有多宽，单位是「一个中文字符」。
   *
   * 用来决定字段占半行还是整行：中文按 1 算，英文数字按 0.55 算。
   * 短字段（姓名、性别、学历…）两两并排，长字段（自我评价、工作内容…）独占一行，
   * 这样一屏能多看好几倍的字段，又不会把长内容挤成省略号。
   */
  function displayWidth(str) {
    const s = String(str == null ? '' : str);
    let w = 0;
    for (const ch of s) {
      const code = ch.codePointAt(0);
      // CJK 统一表意文字、假名、全角标点都按一个汉字宽
      const wide = (code >= 0x2e80 && code <= 0x9fff) ||
                   (code >= 0xac00 && code <= 0xd7af) ||
                   (code >= 0xf900 && code <= 0xfaff) ||
                   (code >= 0xff00 && code <= 0xffef);
      w += wide ? 1 : 0.55;
    }
    return w;
  }

  /** 这个字段该不该独占一整行 */
  function needsFullRow(item) {
    // 半行单元格里，值大约能放 11 个汉字宽
    return displayWidth(item.value) > 9 || displayWidth(item.label) > 5;
  }

  function refreshStatus() {
    if (!panelEl) return;
    const box = panelEl.querySelector('.dp-status');
    if (!box) return;
    box.textContent = '';
    box.className = 'dp-status';

    if (armedItem) {
      box.classList.add('armed');
      box.appendChild(document.createTextNode(`已选定「${armedItem.label}」— 点页面上的输入框`));
      const cancel = el('button', null, '取消');
      cancel.addEventListener('click', () => {
        armedItem = null;
        RA.pick.stop();
        refreshStatus();
      });
      box.appendChild(cancel);
    } else if (targetEl && targetEl.isConnected) {
      box.classList.add('armed');
      box.appendChild(document.createTextNode('已选中输入框 — 点下面的数据填入'));
      const cancel = el('button', null, '取消');
      cancel.addEventListener('click', () => {
        clearTarget();
        RA.pick.stop();
      });
      box.appendChild(cancel);
    } else if (RA.pick.isActive()) {
      box.classList.add('armed');
      box.appendChild(document.createTextNode('正在选取输入框 — 点页面上的空框'));
      const cancel = el('button', null, '取消');
      cancel.addEventListener('click', () => {
        RA.pick.stop();
        refreshStatus();
      });
      box.appendChild(cancel);
    } else {
      box.appendChild(document.createTextNode(
        '点下方「选取输入框」，再点页面上的空框；也可以直接点「复制」自己粘贴。'
      ));
    }
  }

  /** 搜索时强制展开，否则折叠会藏住搜索结果 */
  function isExpanded(key) {
    return filterText.trim() ? true : !collapsedModules.has(key);
  }

  function toggleModule(key) {
    if (collapsedModules.has(key)) collapsedModules.delete(key);
    else collapsedModules.add(key);
  }

  function renderRow(it) {
    const wide = needsFullRow(it);
    const row = el('div', 'dp-row' + (wide ? ' wide' : ''));
    row.title = '点击填入选中的输入框';

    const k = el('span', 'dp-k', it.label);
    k.title = it.label; // 标签被截断时悬停可看全
    row.appendChild(k);

    const v = el('span', 'dp-v', it.value);
    v.title = it.value; // 被截断时鼠标悬停可看全
    row.appendChild(v);

    const copyBtn = el('button', 'dp-c', '复制');
    copyBtn.title = '复制到剪贴板';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation(); // 别触发整行的「填入」
      const ok = await copyToClipboard(it.value);
      copyBtn.textContent = ok ? '已复制' : '失败';
      RA.overlay.showToast(ok ? `已复制「${it.label}」` : '复制失败，请手动选中复制');
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1400);
    });
    row.appendChild(copyBtn);

    row.addEventListener('click', () => {
      if (targetEl && targetEl.isConnected) {
        doFill(targetEl, it);
      } else {
        armItem(it);
      }
    });

    return row;
  }

  function renderModule(g, entries) {
    const expanded = isExpanded(g.key);
    const mod = el('div', 'dp-mod' + (expanded ? ' open' : ''));

    const head = el('button', 'dp-modhead');
    head.type = 'button';
    head.appendChild(el('span', 'dp-chev', expanded ? '▾' : '▸'));
    head.appendChild(el('span', 'dp-modname', g.title));
    head.appendChild(el('span', 'dp-count', `${entries.reduce((s, e) => s + e.items.length, 0)} 项`));
    head.addEventListener('click', () => {
      if (filterText.trim()) return; // 搜索时不折叠
      toggleModule(g.key);
      renderBody(lastGroups);
    });
    mod.appendChild(head);

    if (!expanded) return mod;

    const bodyEl = el('div', 'dp-modbody');
    for (const e of entries) {
      // 数组类模块用条目小标题分隔；简单模块（基本信息等）不加
      if (g.isArray && e.title) bodyEl.appendChild(el('div', 'dp-entry', e.title));
      for (const it of e.items) bodyEl.appendChild(renderRow(it));
    }
    mod.appendChild(bodyEl);
    return mod;
  }

  function renderBody(groups) {
    if (!panelEl) return;
    const body = panelEl.querySelector('.dp-body');
    body.textContent = '';

    const q = RA.normalize.text(filterText);
    let shownModules = 0;

    for (const g of groups) {
      let entries = g.entries;

      if (q) {
        entries = g.entries
          .map((e) => ({
            ...e,
            items: e.items.filter((it) =>
              RA.normalize.text(it.label + ' ' + it.value).includes(q)),
          }))
          .filter((e) => e.items.length);
        if (!entries.length) continue;
      }

      body.appendChild(renderModule(g, entries));
      shownModules++;
    }

    if (!shownModules) {
      body.appendChild(el('div', 'dp-empty',
        filterText ? '没有匹配的数据' : '简历还没有内容，先去选项页填数据'));
    }
  }

  // ─────────────────────── 生命周期 ───────────────────────

  let lastGroups = null;

  async function open() {
    const profile = await RA.storage.getProfile();
    if (!profile) {
      RA.overlay.showToast('还没有填写简历数据');
      return false;
    }

    close();
    const shadow = RA.overlay.ensureHost();

    panelEl = el('div', 'datapanel');
    panelEl.setAttribute('data-ra-ignore', '');

    const head = el('div', 'dp-head');
    head.appendChild(el('span', null, '简历数据'));
    const closeBtn = el('button', null, '×');
    closeBtn.title = '关闭面板（不会撤销已填内容）';
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    panelEl.appendChild(head);

    panelEl.appendChild(el('div', 'dp-status'));

    const search = el('div', 'dp-search');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '搜索数据…';
    input.addEventListener('input', () => {
      filterText = input.value;
      if (lastGroups) renderBody(lastGroups);
    });
    search.appendChild(input);
    panelEl.appendChild(search);

    panelEl.appendChild(el('div', 'dp-body'));

    // 手动一个个填的时候，「全部撤销」太重了——只撤最近一次才顺手
    const foot = el('div', 'dp-foot');
    const pickBtn = el('button', null, '选取输入框');
    pickBtn.title = '点一下页面上的空框，把它设为待填目标';
    pickBtn.addEventListener('click', startPicking);
    foot.appendChild(pickBtn);

    const undoBtn = el('button', null, '撤销上一次填入');
    undoBtn.addEventListener('click', () => {
      const r = RA.fill.undoLast();
      if (r.ok) {
        RA.overlay.showToast('已撤销上一次填入');
        try { RA.overlay.clearMarks(); } catch (e) { /* 忽略 */ }
      } else {
        RA.overlay.showToast('没有可撤销的内容');
      }
    });
    foot.appendChild(undoBtn);
    panelEl.appendChild(foot);

    shadow.appendChild(panelEl);

    // 抓标题栏可以把面板拖到任意位置；拖动时会从「靠右贴边」换成 left/top 定位
    RA.overlay.makeDraggable(panelEl, head, true);

    // 面板是整高的右侧栏，会把右下角的悬浮按钮和首页卡片盖住
    RA.overlay.closeHome();
    RA.overlay.setFabVisible(false);

    // 结果面板和数据面板都停在右下角，会叠在一起
    const wrap = shadow.querySelector('.wrap');
    if (wrap) wrap.remove();

    // 面板只显示模板里的字段——用户精简模板就是为了不被无关字段淹没
    try {
      // 当前简历所用的模板
      activeTemplate = await RA.storage.getActiveTemplate();
    } catch (e) {
      activeTemplate = null;
    }

    lastGroups = buildGroups(profile, activeTemplate);
    renderBody(lastGroups);
    refreshStatus();
    return true;
  }

  function close() {
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
    targetEl = null;
    armedItem = null;
    filterText = '';
    lastGroups = null;
    try {
      RA.pick.stop();
      RA.overlay.clearHighlight();
      RA.overlay.setFabVisible(true);
    } catch (e) { /* 忽略 */ }
  }

  function isOpen() {
    return !!panelEl && panelEl.isConnected;
  }

  /**
   * 返回 {open, reason} 而不是布尔值。
   * 布尔值分不清「刚关掉了」和「打不开」——调用方就没法给出正确反馈。
   */
  async function toggle() {
    if (isOpen()) {
      close();
      return { open: false, reason: 'closed' };
    }
    const ok = await open();
    return ok ? { open: true } : { open: false, reason: 'no-profile' };
  }

  /** 数据改了（比如用户在选项页保存了）之后刷新面板 */
  async function refresh() {
    if (!isOpen()) return;
    const profile = await RA.storage.getProfile();
    if (!profile) { close(); return; }

    try {
      // 当前简历所用的模板
      activeTemplate = await RA.storage.getActiveTemplate();
    } catch (e) { /* 用上一次的模板 */ }

    lastGroups = buildGroups(profile, activeTemplate);
    renderBody(lastGroups);
    refreshStatus();
  }

  RA.datapanel = {
    toggle,
    open,
    close,
    isOpen,
    refresh,
    buildGroups,
    copyToClipboard,
    setTarget,
    clearTarget,
    startPicking,
    getTarget: () => targetEl,
    // 调试/测试用
    _isExpanded: isExpanded,
    _toggleModule: toggleModule,
    _resetExpanded: () => collapsedModules.clear(),
    _displayWidth: displayWidth,
    _needsFullRow: needsFullRow,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
