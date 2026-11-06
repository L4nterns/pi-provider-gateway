import type { AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, Loader, matchesKey, ScrollView, Text, truncateToWidth } from '@earendil-works/pi-tui';

// Use Pi's active theme/keybindings and native spinner; cancellation waits for I/O
// to settle before releasing the command lock, rather than leaving work in the background.
export async function progress<T>(ctx: ExtensionCommandContext, message: string, parent: AbortSignal, work: (signal: AbortSignal, report: (message: string) => void) => Promise<T>): Promise<T> {
  const outcome = await ctx.ui.custom<{ value: T } | { error: unknown }>((tui, theme, keys, done) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    const loader = new Loader(tui, s => theme.fg('accent', s), s => theme.fg('muted', s), message);
    const report = (text: string) => { if (!signal.aborted) loader.setMessage(text); };
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal, report); })
      .then(value => done({ value }), error => done({ error }));
    return {
      render: width => [...loader.render(width), truncateToWidth('「Esc」取消', width)],
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel')) {
          controller.abort(new Error('已取消 Gateway 操作'));
          loader.setMessage('正在取消…');
        }
      },
      invalidate() { loader.invalidate(); },
      dispose() { controller.abort(); loader.stop(); },
    };
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

// A secret never reaches the ordinary editor, scrollback, session entries or model context.
// Deliberately append/backspace only; no clipboard/history integration.
export function secretInput(ctx: ExtensionCommandContext, message: string, signal?: AbortSignal): Promise<string> {
  if (ctx.mode !== 'tui') return Promise.reject(new Error('密钥输入需要 Pi 交互终端；请在终端运行 /gateway'));
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    let value = ''; let ended = false;
    const finish = (result: string | undefined) => { if (ended) return; ended = true; signal?.removeEventListener('abort', cancel); done(result); };
    const cancel = () => finish(undefined);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) queueMicrotask(cancel);
    return {
      focused: true,
      render(width) { return [truncateToWidth(theme.fg('accent', message), width), truncateToWidth(`> ${'*'.repeat(Math.min(value.length, Math.max(0, width - 4)))}`, Math.max(0, width - 1)) + CURSOR_MARKER + ' ', truncateToWidth('「Esc」取消 · 「Enter」确认', width)]; },
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel')) { cancel(); return; }
        if (keys.matches(data, 'tui.select.confirm')) { finish(value); return; }
        if (matchesKey(data, 'backspace')) value = value.slice(0, -1);
        else if (matchesKey(data, 'ctrl+u')) value = '';
        else {
          const text = data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '');
          if (text && !/[\x00-\x20\x7f-\x9f]/.test(text) && !text.includes('\x1b') && value.length + text.length <= 8192) value += text;
        }
        tui.requestRender();
      },
      invalidate() {},
      dispose() { signal?.removeEventListener('abort', cancel); value = ''; },
    };
  }, { blocked: { kind: 'auth', message } }).then(value => { if (value === undefined) throw new Error('已取消密钥输入'); return value; });
}
// Native components and Pi's renderer own wrapping/diffing. This screen has no
// editor, submit path, external editor, persistence or model-context messages.
export function readOnly(ctx: ExtensionCommandContext, title: string, body: string): Promise<void> {
  return ctx.ui.custom<void>((tui, theme, keys, done) => {
    const text = new Text(body, 0, 0);
    const scroll = new ScrollView(text, { overscroll: 'contain' });
    let visible = 1;
    return {
      capturesViewportInput: true,
      render(width) {
        visible = Math.max(1, Math.min(22, tui.terminal.rows - 7));
        const lines = scroll.render(width);
        scroll.updateLayout(lines.length, visible, () => tui.requestRender());
        return [truncateToWidth(theme.fg('accent', title), width), '', ...lines.slice(scroll.scrollTop, scroll.scrollTop + visible), '', truncateToWidth(theme.fg('dim', '「Esc」返回 · 「↑/↓」滚动 · 「PgUp/PgDn」翻页'), width)];
      },
      handleInput(data) {
        if (keys.matches(data, 'tui.select.cancel')) { done(); return; }
        if (keys.matches(data, 'tui.select.up')) scroll.scrollBy(-1);
        else if (keys.matches(data, 'tui.select.down')) scroll.scrollBy(1);
        else if (keys.matches(data, 'tui.select.pageUp')) scroll.scrollBy(-visible);
        else if (keys.matches(data, 'tui.select.pageDown')) scroll.scrollBy(visible);
        else if (matchesKey(data, 'home')) scroll.scrollToStart();
        else if (matchesKey(data, 'end')) scroll.scrollToEnd();
        else return;
        tui.requestRender();
      },
      invalidate() { text.invalidate(); },
    };
  }, { blocked: { kind: 'question', message: title } });
}

export function interaction(ctx: ExtensionCommandContext, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    async prompt(prompt: AuthPrompt) {
      const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
      promptSignal.throwIfAborted();
      if (prompt.type === 'secret') return secretInput(ctx, prompt.message, promptSignal);
      if (prompt.type === 'select') {
        const labels = prompt.options.map(o => o.description ? `${o.label}  ${o.description}` : o.label);
        const choice = await ctx.ui.select(prompt.message, labels, { signal: promptSignal });
        if (choice === undefined) throw new Error('已取消');
        return prompt.options[labels.indexOf(choice)].id;
      }
      const value = await ctx.ui.input(prompt.message, prompt.placeholder, { signal: promptSignal });
      if (value === undefined) throw new Error('已取消');
      return value;
    },
    notify(event) { if ('message' in event) ctx.ui.notify(event.message, 'info'); },
  };
}
