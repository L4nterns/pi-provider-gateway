import type { AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

// A secret never reaches the ordinary editor, scrollback, session entries or model context.
// Deliberately append/backspace only; no clipboard/history integration.
export function secretInput(ctx: ExtensionCommandContext, message: string, signal?: AbortSignal): Promise<string> {
  if (ctx.mode !== 'tui') return Promise.reject(new Error('密钥输入需要 Pi 交互终端；也可使用原生 /login'));
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    let value = ''; let ended = false;
    const finish = (result: string | undefined) => { if (ended) return; ended = true; signal?.removeEventListener('abort', cancel); done(result); };
    const cancel = () => finish(undefined);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) queueMicrotask(cancel);
    return {
      focused: true,
      render(width) { return [truncateToWidth(theme.fg('accent', message), width), truncateToWidth(`> ${'*'.repeat(Math.min(value.length, Math.max(0, width - 4)))}`, Math.max(0, width - 1)) + CURSOR_MARKER + ' ', truncateToWidth('Enter 确认 · Esc 取消（密钥不会写入会话）', width)]; },
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
export function interaction(ctx: ExtensionCommandContext, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    async prompt(prompt: AuthPrompt) {
      signal.throwIfAborted();
      if (prompt.type === 'secret') return secretInput(ctx, prompt.message, signal);
      if (prompt.type === 'select') {
        const choice = await ctx.ui.select(prompt.message, prompt.options.map(o => `${o.label} [${o.id}]`), { signal });
        if (choice === undefined) throw new Error('已取消');
        const index = prompt.options.findIndex(o => `${o.label} [${o.id}]` === choice);
        return prompt.options[index].id;
      }
      const value = await ctx.ui.input(prompt.message, prompt.placeholder, { signal });
      if (value === undefined) throw new Error('已取消');
      return value;
    },
    notify(event) { if ('message' in event) ctx.ui.notify(event.message, 'info'); },
  };
}
