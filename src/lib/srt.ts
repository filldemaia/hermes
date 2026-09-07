/** Converteix subtítols SRT a WebVTT. */
export function srtToVtt(text: string): string {
  const cleaned = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const out: string[] = ['WEBVTT', ''];
  const blocks = cleaned.split(/\n{2,}/g);
  let idx = 0;
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const cueId = timeIdx > 0 && !/^\s*\d+\s*$/.test(lines[timeIdx - 1]) ? lines[timeIdx - 1].trim() : String(idx + 1);
    const payload = lines.slice(timeIdx + 1);
    if (!payload.length) continue;

    const times = lines[timeIdx].trim().split(/\s+-->\s+/);
    const fmtTime = (t: string): string => {
      const clean = t.replace(',', '.').trim();
      const m = clean.match(/^(\d{1,2}):(\d{2}):(\d{2})(\.\d+)?$/);
      if (m) {
        return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}:${m[3]}${(m[4] || '.000').slice(0, 4)}`;
      }
      const m2 = clean.match(/^(\d{1,2}):(\d{2})(\.\d+)?$/);
      if (m2) {
        return `00:${String(Number(m2[1])).padStart(2, '0')}:${m2[2]}${(m2[3] || '.000').slice(0, 4)}`;
      }
      return clean;
    };
    if (times.length < 2) continue;
    const timing = `${fmtTime(times[0])} --> ${fmtTime(times.slice(1).join('-->'))}`;
    const cueText = payload.join('\n').replace(/<br\s*\/?>/gi, '\n');

    out.push(cueId);
    out.push(timing);
    out.push(cueText);
    out.push('');
    idx++;
  }
  if (idx === 0) return '';
  return out.join('\n') + '\n';
}

