// The pre-write guard. Before the filter writes anything — into a note, or on
// the web tool's page — it checks the result against what was selected, and
// refuses when the one promise it makes would break:
//
//   only duplicate numbers go. Every name, every section label, every address,
//   every email and every line he wrote stays, in its place, under its section.
//
// Pure functions, no DOM: the extension and the web tool both load this file,
// and the Node tests run it as it ships. Needs filter.js loaded first.

// Built from code points so no editing tool can turn the escapes into the
// invisible characters themselves.
const EF_INVIS_RE = new RegExp('[' + [[0x200B, 0x200F], [0x2060, 0x2064], [0xFEFF, 0xFEFF], [0xAD, 0xAD]]
    .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');

// Words that may vanish from a source row when it is rebuilt into a clean
// number: providers, record types, phone types. A row holding any other word
// is not a source row — something was written on it.
const EF_ROW_VOCAB = new Set((
    'experian gateway transunion equifax lexisnexis historic historical credit bureau bank account ' +
    'header records record phone motor vehicle service warranty business contact email household ' +
    'listing professional licenses license work affiliations new movers utility voter residence ' +
    'residential land line landline wireless voip voice cellular cell mobile home current previous ' +
    'null sources source type hone s'
).split(/\s+/));

// The "EMAIL ADDRESS:" label (also cut short, "MAIL ADDRESS:") is one of the
// lines the filter is allowed to take out; the emails under it stay.
const EF_EMAIL_LABEL_RE = /^\s*(?:e?mail|ail|il|l)?\s*address\s*:\s*$/i;

const EF_TEN_DIGIT_RE =/\(?\d{3}\)?[\s.\-]{0,2}\d{3}[\s.\-]{0,2}\d{4}/g;
const EF_SEVEN_DIGIT_RE = /\b\d{3}-\d{4}\b/g;

function efGuardClean(t) {
    return String(t || '').replace(EF_INVIS_RE, '');
}

// True when every word on the line is source vocabulary (a "//note" at the end
// is his and rides along with the number, so it does not count against it).
function efIsRowVocabOnly(text) {
    let t = efGuardClean(text);
    const hasTabs = /\t/.test(t);
    t = t.replace(/\/\/.*$/, ' ').replace(EF_TEN_DIGIT_RE, ' ').replace(EF_SEVEN_DIGIT_RE, ' ');
    // anything but Latin words and column punctuation — a date "10/12", "❌",
    // a note in Arabic — is his writing, so the row is not a source row
    // (ChatGPT review #1, 2026-11-15)
    if (/[^A-Za-z\s,&#()\-:.]/.test(t)) return false;
    const words = t.toLowerCase().match(/[a-z]+/g) || [];
    if (!words.length) return hasTabs && efExtractPhoneNumbers(efGuardClean(text)).length > 0;
    return words.every(w => EF_ROW_VOCAB.has(w));
}

// What is left of a line once its numbers and the filter's own tag are gone.
function efGuardRest(t) {
    return efGuardClean(t).replace(EF_TEN_DIGIT_RE, ' ').replace(/\bcellular\b/ig, ' ')
        .replace(/[\s,;:.\-–—()]+/g, '');
}

const EF_CITY_SHAPE_RE = /^[A-Za-z][A-Za-z\s]+,?\s*[A-Z]{2}\s*\d{4,5}(?:-\d{4})?$/;
// The rest of a street cut onto its own line ("APT 2T"); joined to the street.
const EF_UNIT_LINE_RE = /^\s*(?:apt|unit|suite|ste|room|rm|floor|fl|#)\s*[A-Za-z0-9-]+\s*$/i;
const efGuardNorm = s => efGuardClean(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const efGuardLine = s => efGuardClean(s).replace(/\s+/g, ' ').trim();

// Walk lines, tagging each with its section (one occurrence of a label) and
// the person it sits under.
function efGuardWalk(lines, opts) {
    let section = 0, person = '';
    return lines.map(raw => {
        const t = efGuardClean(raw);
        const blank = !t.trim();
        let head = null;
        if (!blank && opts.isName(t)) {
            if (opts.isSection(t)) { section++; person = ''; head = { kind: 'section', key: opts.nameKey(t) }; }
            else { person = opts.nameKey(t); head = { kind: 'person', key: opts.nameKey(t) }; }
        }
        return { text: t, blank, head, group: section + '|' + person, section };
    });
}

function efGuardCheck(before, after, opts) {
    const problems = [];
    const add = (kind, text) => problems.push({ kind, text: String(text).trim() });
    const afterLines = String(after || '').split('\n');
    const afterText = afterLines.join('\n');

    const b = efGuardWalk(before, opts);
    const a = efGuardWalk(afterLines, opts);

    // 1. heads: every label, and every person once per section, in order
    const want = [], seen = new Set();
    b.forEach(l => {
        if (!l.head) return;
        if (l.head.kind === 'person') {
            const k = l.section + '|' + l.head.key;
            if (seen.has(k)) return;
            seen.add(k);
        }
        want.push({ key: l.head.key, text: l.text });
    });
    const got = a.filter(l => l.head).map(l => ({ key: l.head.key, text: l.text }));
    const count = (list) => list.reduce((m, x) => m.set(x.key, (m.get(x.key) || 0) + 1), new Map());
    const wc = count(want), gc = count(got);
    let missing = false;
    wc.forEach((n, k) => {
        if ((gc.get(k) || 0) < n) { missing = true; add('head-missing', want.find(x => x.key === k).text); }
    });
    if (!missing) {
        const i = want.findIndex((x, j) => !got[j] || got[j].key !== x.key);
        if (i >= 0) add('head-order', want[i].text);
    }

    // 2. emails
    const afterLower = afterText.toLowerCase();
    const emails = new Set(before.flatMap(t => efExtractEmails(efGuardClean(t))).map(e => e.toLowerCase()));
    emails.forEach(e => { if (!afterLower.includes(e)) add('email', e); });

    // 3. addresses (a street and its city may be joined into one line)
    const afterNorm = efGuardNorm(afterText);
    const isPlace = (l) => !opts.isRaw(l.text) && !l.head && efExtractPhoneNumbers(l.text).length === 0 &&
        (!!efExtractAddressFromLine(l.text) || EF_CITY_SHAPE_RE.test(l.text.trim()) || EF_UNIT_LINE_RE.test(l.text));
    b.forEach(l => {
        if (l.blank || !isPlace(l)) return;
        if (!afterNorm.includes(efGuardNorm(l.text))) add('address', l.text);
    });

    // 4. every other line he has, as often as the groups it sits in
    if (opts.verbatim) {
        const exempt = (l) => l.blank || l.head || opts.isRaw(l.text) || isPlace(l) ||
            /^\s*\d{3}[-.\s]\d{4}\s*$/.test(l.text) ||       // a 7-digit number may go
            !efGuardRest(l.text.replace(/\S+@\S+/g, ' '));
        const groupsOf = new Map();
        b.forEach(l => {
            if (exempt(l)) return;
            const k = efGuardLine(l.text);
            if (!groupsOf.has(k)) groupsOf.set(k, new Set());
            groupsOf.get(k).add(l.group);
        });
        const afterCount = afterLines.reduce((m, t) => {
            const k = efGuardLine(t); return m.set(k, (m.get(k) || 0) + 1);
        }, new Map());
        groupsOf.forEach((groups, k) => {
            if ((afterCount.get(k) || 0) < groups.size) add('line', k);
        });
    }

    // 5. a source row may only lose source words (in the note only: the web
    //    tool's panel carries names, addresses, emails and numbers by design)
    if (opts.verbatim) {
    const afterWords = new Set((afterLower.match(/[a-z]+/g) || []));
    b.forEach(l => {
        if (l.blank || !opts.isRaw(l.text) || efIsRowVocabOnly(l.text) || EF_EMAIL_LABEL_RE.test(l.text)) return;
        const words = (l.text.replace(/\/\/.*$/, ' ').toLowerCase().match(/[a-z]+/g) || [])
            .filter(w => !EF_ROW_VOCAB.has(w));
        if (words.some(w => !afterWords.has(w))) add('row-words', l.text);
    });
    }

    // 6. numbers: each once (more only when each copy carries a note), none new
    const beforeNums = new Set();
    const notesOn = new Map();
    b.forEach(l => {
        const nums = efExtractPhoneNumbers(l.text);
        nums.forEach(n => beforeNums.add(n));
        const noted = opts.isRaw(l.text) ? /\/\/\s*\S/.test(l.text) : !!efGuardRest(l.text);
        if (noted) nums.forEach(n => notesOn.set(n, (notesOn.get(n) || 0) + 1));
    });
    const afterNums = afterLines.map(t => efExtractPhoneNumbers(efGuardClean(t)));
    beforeNums.forEach(n => {
        const c = afterNums.filter(ns => ns.includes(n)).length;
        if (c > Math.max(1, notesOn.get(n) || 0)) add('number-twice', n);
        if (c === 0 && !(opts.outside && opts.outside.has(n))) add('number-missing', n);
    });
    new Set(afterNums.flat()).forEach(n => { if (!beforeNums.has(n)) add('number-new', n); });

    return { ok: problems.length === 0, problems };
}
