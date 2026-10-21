/**
 * 轻量弹窗：确认 / 提示 / 输入。
 *
 * 原生 confirm / alert / prompt 由浏览器绘制，样式完全不可控（深色系统下是一块
 * 灰黑系统框），还会阻塞整个页面。这里换成自绘的对话框，返回 Promise。
 *
 *   await RA.ui.dialog.confirm({ title:'删除', message:'确定吗？', danger:true })
 *   await RA.ui.dialog.alert({ title:'提示', message:'…' })
 *   const name = await RA.ui.dialog.prompt({ title:'重命名', label:'名称', value:'旧名' })
 */
(function (root) {
  'use strict';

  const RA = root.RA;
  RA.ui = RA.ui || {};

  /** 同一时刻只留一个对话框 */
  let active = null;

  function close(result) {
    if (!active) return;

    const a = active;
    active = null;

    document.removeEventListener('keydown', a.onKey, true);
    if (a.mask.parentNode) a.mask.remove();
    a.resolve(result);
  }

  function open(opts) {
    if (active) close(null);

    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'ui-dialog-mask';

      const box = document.createElement('div');
      box.className = 'ui-dialog';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      const title = document.createElement('h3');
      title.className = 'ui-dialog-title';
      title.textContent = opts.title || '';
      if (title.textContent) box.appendChild(title);

      const body = document.createElement('div');
      body.className = 'ui-dialog-body';
      body.textContent = opts.message || '';
      if (body.textContent) box.appendChild(body);

      let input = null;
      if (opts.input) {
        if (opts.label) {
          const lab = document.createElement('label');
          lab.className = 'ui-dialog-label';
          lab.textContent = opts.label;
          box.appendChild(lab);
        }

        input = document.createElement('input');
        input.type = 'text';
        input.className = 'ui-dialog-input';
        input.value = opts.value == null ? '' : String(opts.value);
        input.placeholder = opts.placeholder || '';
        box.appendChild(input);
      }

      const actions = document.createElement('div');
      actions.className = 'ui-dialog-actions';
      box.appendChild(actions);

      // 输入框弹窗取消返回 null，其余返回 false
      const cancelResult = () => (opts.input ? null : false);

      if (!opts.hideCancel) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn ui-dialog-cancel';
        cancel.textContent = opts.cancelText || '取消';
        cancel.addEventListener('click', () => close(cancelResult()));
        actions.appendChild(cancel);
      }

      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'btn btn-primary ui-dialog-ok' + (opts.danger ? ' danger' : '');
      ok.textContent = opts.okText || '确定';
      ok.addEventListener('click', () => close(opts.input ? input.value : true));
      actions.appendChild(ok);

      mask.appendChild(box);

      // 点遮罩空白处关闭
      mask.addEventListener('click', (e) => {
        if (e.target === mask) close(cancelResult());
      });

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close(cancelResult());
        } else if (e.key === 'Enter' && opts.input) {
          e.stopPropagation();
          close(input.value);
        }
      };
      document.addEventListener('keydown', onKey, true);

      active = { resolve, mask, onKey };
      document.body.appendChild(mask);

      setTimeout(() => {
        if (input) {
          input.focus();
          input.select();
        } else {
          ok.focus();
        }
      }, 0);
    });
  }

  /** 确定返回 true，取消 / 关闭返回 false */
  function confirm(opts) {
    const o = typeof opts === 'string' ? { message: opts } : opts;
    return open(o).then((v) => v === true);
  }

  /** 只有一个「知道」按钮 */
  function alert(opts) {
    const o = typeof opts === 'string' ? { message: opts } : opts;
    return open({ ...o, hideCancel: true }).then(() => undefined);
  }

  /** 确定返回输入内容（可能是空串），取消返回 null */
  function prompt(opts) {
    return open({ ...opts, input: true });
  }

  RA.ui.dialog = { confirm, alert, prompt };
})(typeof globalThis !== 'undefined' ? globalThis : window);
