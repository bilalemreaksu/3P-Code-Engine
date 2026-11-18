import { pathToFileURL } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { getJob, resumeSession } from './execution-manager.mjs';

function safeText(value) {
  return String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, char => JSON.stringify(char).slice(1, -1));
}

export function viewerKey(state, key) {
  // key.name keeps letter case ('Q' when Shift is held), so keys are matched
  // case-insensitively: the help line advertises 'Q: çık' and a capital Q must
  // actually quit.
  const name = String(key.name || '').toLowerCase();
  if ((key.ctrl && name === 'c') || name === 'q' || name === 'escape') return false;
  if (key.ctrl && name === 'o') state.transcript = !state.transcript;
  if (name === 'up') state.selected = Math.max(0, state.selected - 1);
  if (name === 'down') state.selected = Math.min(state.jobs.length - 1, state.selected + 1);
  if (name === 'return' || name === 'space') {
    const id = state.jobs[state.selected]?.id;
    if (state.expanded.has(id)) state.expanded.delete(id); else if (id) state.expanded.add(id);
  }
  return true;
}

export function renderViewer(state) {
  const lines = ['3P Code Mode · Ctrl+O: transcript · ↑/↓: seç · Enter: kodu aç/kapat · R: yenile · Q: çık', ''];
  for (const [index, job] of state.jobs.entries()) {
    lines.push(`${index === state.selected ? '>' : ' '} ${safeText(job.id)} · ${safeText(job.status)}`);
    if (state.transcript) {
      const expanded = state.expanded.has(job.id);
      lines.push(`  [${expanded ? '-' : '+'}] Code · Enter ile ${expanded ? 'daralt' : 'genişlet'}`);
      if (expanded) lines.push(...safeText(job.result?.transcript || 'Saklanan kod kaydı yok.').split('\n').map(line => `    ${line}`));
    }
    if (job.result?.outputBlocked) {
      lines.push(`  ${safeText(job.result.error)}`);
      continue;
    }
    for (const approval of job.pendingApprovals || []) lines.push(`  Onay bekleniyor: ${safeText(approval.tool)} · son tarih ${safeText(approval.deadline)} · ${safeText(approval.url || 'Broker bağlantısı hazırlanıyor')}`);
    const record = formatRecord({ ...job.result, transcript: ' ' });
    lines.push(...record.split('\n').slice(3));
    if (job.result?.error) lines.push(`  Hata: ${safeText(job.result.error)}`);
    if (job.result?.result !== undefined) lines.push(`  Sonuç: ${safeText(job.result.result)}`);
    if (job.result?.logs) lines.push(`  Günlük: ${safeText(job.result.logs)}`);
    if (job.status === 'running') for (const event of job.events || []) lines.push(`  ${safeText(event.kind)}: ${safeText(event.data)}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function interactiveViewer(loadJobs, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error('--interactive için etkileşimli terminal gerekli');
  const state = { jobs: loadJobs(), selected: 0, expanded: new Set(), transcript: false };
  const draw = () => output.write(`\x1b[2J\x1b[H${renderViewer(state)}\n`);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true); input.resume();
  try {
    draw();
    await new Promise((resolve, reject) => {
      const cleanup = () => { input.removeListener('keypress', onKey); input.removeListener('end', onEnd); input.removeListener('error', onError); };
      const onEnd = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const onKey = (_, key = {}) => {
        try {
          if (!viewerKey(state, key)) { onEnd(); return; }
          if (key.name === 'r') { state.jobs = loadJobs(); state.selected = Math.max(0, Math.min(state.selected, state.jobs.length - 1)); }
          draw();
        } catch (error) { onError(error); }
      };
      input.on('keypress', onKey); input.once('end', onEnd); input.once('error', onError);
    });
  } finally {
    input.setRawMode(Boolean(wasRaw)); input.pause();
    // ConPTY can keep the read handle referenced after pause on Windows;
    // unref is not enough for the process to exit, so release the handle.
    input.unref?.();
    try { input.destroy(); } catch { /* already destroyed */ }
  }
}

export function formatRecord(result) {
  if (!result?.transcript) return null;
  const lines = ['Yürütülen kod:', ...safeText(result.transcript).split('\n').map(line => `    ${line}`), '', 'Yardımcı işlemler:'];
  for (const op of result.operations || []) {
    lines.push(`- ${op.operation}: ${safeText(op.file || op.command || op.server || '')}`);
    if (op.operation !== 'edit') continue;
    lines.push('  Önce / Sonra');
    lines.push(...safeText(op.oldText).split('\n').map(line => `  - ${line}`));
    lines.push(...safeText(op.newText).split('\n').map(line => `  + ${line}`));
    if (op.truncated) lines.push('  Değişiklik önizlemesi kesildi.');
  }
  if (!(result.operations || []).length) lines.push('- Kaydedilen yardımcı işlem yok.');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [type, id, option] = process.argv.slice(2);
    if (option && option !== '--interactive') throw new Error(`Bilinmeyen seçenek: ${option}`);
    if (option === '--interactive' && id && ['session', 'job'].includes(type)) {
      await interactiveViewer(() => type === 'job' ? [getJob(id)] : resumeSession(id).history.map(jobId => {
        try { return getJob(jobId); } catch { return { id: jobId, status: 'deleted', events: [] }; }
      }));
    } else if (type === 'session' && id) {
      const session = resumeSession(id);
      console.log(safeText(JSON.stringify(session, null, 2)));
    } else if (type === 'job' && id) {
      const job = getJob(id);
      console.log(`${job.id} · ${job.status}`);
      if (job.result?.error) console.log(safeText(job.result.error));
      console.log(formatRecord(job.result) ?? 'Saklanan kod kaydı yok.');
    } else {
      throw new Error('Kullanım: node code-mode-transcript.mjs <job|session> <kimlik> [--interactive]');
    }
  } catch (error) {
    console.error(safeText(error.message));
    process.exitCode = 1;
  }
}
