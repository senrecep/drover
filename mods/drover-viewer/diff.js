// Line diff for the save-conflict view: common prefix/suffix trimmed, LCS on the middle.
// Rows: {t: " " | "-" | "+" | "…", text, a?, b?}  (a/b: 1-based line numbers on disk / in the draft)
export const DIFF_CELLS = 4000000;
const CONTEXT = 3;

const lines = (s) => {
  if (s == null || s === "") return [];
  const l = String(s).split("\n");
  if (l.length > 1 && l[l.length - 1] === "") l.pop();
  return l.map((x) => (x.endsWith("\r") ? x.slice(0, -1) : x));
};

export function lineDiff(disk, draft, cap = DIFF_CELLS) {
  const A = lines(disk), B = lines(draft);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const a = A.slice(p, A.length - s), b = B.slice(p, B.length - s);
  const mid = [];
  let approximate = false;
  if (a.length * b.length > cap) {
    approximate = true;
    a.forEach((text, i) => mid.push({ t: "-", text, a: p + i + 1 }));
    b.forEach((text, j) => mid.push({ t: "+", text, b: p + j + 1 }));
  } else {
    const n = a.length, m = b.length, w = m + 1;
    const L = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { mid.push({ t: " ", text: a[i], a: p + i + 1, b: p + j + 1 }); i++; j++; }
      else if (j < m && (i >= n || L[i * w + j + 1] > L[(i + 1) * w + j])) { mid.push({ t: "+", text: b[j], b: p + j + 1 }); j++; }
      else { mid.push({ t: "-", text: a[i], a: p + i + 1 }); i++; }
    }
  }
  const all = [];
  A.slice(0, p).forEach((text, i) => all.push({ t: " ", text, a: i + 1, b: i + 1 }));
  all.push(...mid);
  A.slice(A.length - s).forEach((text, i) => all.push({ t: " ", text, a: A.length - s + i + 1, b: B.length - s + i + 1 }));
  return { rows: collapse(all), added: all.filter((r) => r.t === "+").length, removed: all.filter((r) => r.t === "-").length, approximate };
}

// Keeps CONTEXT unchanged lines around each change; longer unchanged runs become one "…" row.
function collapse(rows) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => { if (r.t !== " ") for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) keep[k] = true; });
  const out = [];
  for (let i = 0; i < rows.length;) {
    if (keep[i]) { out.push(rows[i]); i++; continue; }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    out.push({ t: "…", text: `${j - i} unchanged line${j - i === 1 ? "" : "s"}` });
    i = j;
  }
  return out;
}
