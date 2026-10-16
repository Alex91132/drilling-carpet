/* Ядро ковра бурения: разбор листа графика бурения и построение графика движения буровых установок (ГДБУ).
   Без DOM и без SheetJS — на входе строки листа (массив массивов), поэтому одинаково работает
   на странице и в тестах. Подключается как window.CarpetCore. */
(function (root) {
  'use strict';

  var DAY = 86400000;

  /* ---------------- справочники ---------------- */
  var GROUP_MAP = {
    'бурение': 'drill', 'освоение': 'completion', 'переезд': 'reloc',
    'ввод скважины в эксплуатацию (вывод скважины на режим)': 'input',
    'ожидание освоения(испытания)': 'wait', 'ожидание освоения (испытания)': 'wait',
    'консервация': 'conservation', 'передвижка': 'move',
    'монтаж': 'mount', 'демонтаж': 'demount', 'обустройство (обвязка)': 'tie',
    'стаскивание буровой установки': 'skid',
    'бурение направления': 'направление', 'бурение кондуктора': 'кондуктор',
    'бурение технической колонны': 'техколонна',
    'бурение эксплуатационной колонны': 'экспколонна',
    'бурение хвостовика': 'хвостовик'
  };
  var SECTION_ORDER = ['направление', 'кондуктор', 'техколонна', 'экспколонна', 'хвостовик'];
  var FIELD_BY_HEADER = { 'дата начала': 's', 'дата окончания': 'e', 'количество дней': 'd', 'расстояние на передвижку': 'dist' };
  var BASE_COLS = {
    'порядок бурения скважины': 'order', 'куст': 'pad', 'номер скважины': 'well',
    'проходка по скважине, м': 'depth', 'проходка по скважине': 'depth',
    'цикл бурения': 'dd', 'цикл строительства': 'bd',
    'коммерческая скорость, м/мес.': 'speed', 'коммерческая скорость, м/мес': 'speed',
    'наименование вида бу': 'rig', 'номер бригады': 'crew', 'месторождение': 'field',
    'дата начала цикла бурения': 'cycS', 'дата окончания цикла бурения': 'cycE',
    'количество грп/стадий мгрп': 'frp', 'количество гнкт': 'gnkt'
  };

  /* ---------------- утилиты ---------------- */
  function norm(s) { return s == null ? '' : String(s).replace(/\s+/g, ' ').trim().toLowerCase(); }
  function blank(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }
  function num(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (blank(v)) return null;
    var x = parseFloat(String(v).replace(',', '.'));
    return isFinite(x) ? x : null;
  }
  function toISO(d) { return d.toISOString().slice(0, 10); }
  /** Дата → 'гггг-мм-дд' (день, без времени). Принимает Date, сериал Excel, 'дд.мм.гггг', 'гггг-мм-дд…'. */
  function parseDate(v) {
    if (blank(v)) return null;
    if (v instanceof Date) return isNaN(v) ? null : toISO(new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), 12)));
    if (typeof v === 'number') {
      if (!isFinite(v) || v < 20000 || v > 80000) return null;   // не дата: 1955–2119 годы
      return toISO(new Date(Math.round((v - 25569) * DAY) + 12 * 3600000));
    }
    var s = String(v).trim(), m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
    if (m) return m[3] + '-' + (m[2].length < 2 ? '0' : '') + m[2] + '-' + (m[1].length < 2 ? '0' : '') + m[1];
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
  }
  function t(iso) { return iso ? Date.parse(iso + 'T12:00:00Z') : null; }
  function iso(ms) { return toISO(new Date(ms)); }
  function addDays(isoDate, d) { return iso(t(isoDate) + Math.round(d) * DAY); }
  /** Номер бригады: '03' и 3 — одна бригада. */
  function normCrew(v) {
    if (blank(v)) return '';
    var s = String(v).trim();
    if (/^\d+(\.0+)?$/.test(s)) return String(parseInt(s, 10));
    return s;
  }
  function str(v) { return blank(v) ? '' : String(v).trim(); }

  /* ---------------- разбор листа ---------------- */
  function findHeader(rows) {
    for (var r = 0; r < Math.min(rows.length, 15); r++) {
      var row = rows[r] || [], pad = -1, well = -1;
      for (var c = 0; c < row.length; c++) {
        var n = norm(row[c]);
        if (n === 'куст') pad = c;
        if (n === 'номер скважины') well = c;
      }
      if (pad >= 0 && well >= 0) return r;
    }
    return -1;
  }

  /**
   * Строки листа графика бурения → скважины.
   * Строка заголовков ищется по «Куст» и «Номер скважины», блоки фаз — по строке над ней (объединённые ячейки
   * «Бурение», «Монтаж», …). Строки-разделители с одним заполненным «Куст» — это куст или месторождение
   * (если значение встречается в столбце «Месторождение»).
   */
  function parseRows(rows, source) {
    var hr = findHeader(rows);
    if (hr < 0) throw new Error('«' + source + '»: не нашёл строку заголовков со столбцами «Куст» и «Номер скважины».');
    var head = rows[hr] || [], groupRow = hr > 0 ? (rows[hr - 1] || []) : [];
    var width = 0;
    for (var i = 0; i <= hr; i++) width = Math.max(width, (rows[i] || []).length);

    var groupAt = [], cur = null;
    for (var c = 0; c < width; c++) {
      var g = norm(groupRow[c]);
      if (g) cur = GROUP_MAP[g] || null;      // чужой заголовок блока сбрасывает группу
      groupAt[c] = cur;
    }
    var phaseCols = {}, base = {};
    for (c = 0; c < width; c++) {
      var h = norm(head[c]);
      if (!h) continue;
      var f = FIELD_BY_HEADER[h];
      if (f) {
        if (groupAt[c]) { phaseCols[groupAt[c]] = phaseCols[groupAt[c]] || {}; phaseCols[groupAt[c]][f] = c; }
        continue;
      }
      if (BASE_COLS[h] && base[BASE_COLS[h]] === undefined) { base[BASE_COLS[h]] = c; continue; }
      if (h.indexOf('профилю ствола') >= 0 && base.type === undefined) base.type = c;
      if (h.indexOf('по назначению') >= 0 && base.purpose === undefined) base.purpose = c;
    }
    if (base.well === undefined || base.pad === undefined) throw new Error('«' + source + '»: нет столбцов «Куст» / «Номер скважины».');
    if (!phaseCols.drill && base.cycS === undefined)
      throw new Error('«' + source + '»: нет дат бурения — ни блока «Бурение», ни «Дата начала цикла бурения».');

    function at(row, key) { var col = base[key]; return col === undefined ? null : row[col]; }

    var fieldNames = {};
    for (var r = hr + 1; r < rows.length; r++) {
      var fv = at(rows[r] || [], 'field');
      if (!blank(fv)) fieldNames[norm(fv)] = str(fv);
    }

    var wells = [], curPad = '', curField = '';
    for (r = hr + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var padRaw = at(row, 'pad'), wellRaw = at(row, 'well');
      if (blank(wellRaw)) {
        if (!blank(padRaw) && blank(at(row, 'order'))) {
          if (fieldNames[norm(padRaw)]) { curField = fieldNames[norm(padRaw)]; curPad = ''; }
          else curPad = str(padRaw);
        }
        continue;
      }
      var w = {
        source: source,
        field: str(at(row, 'field')) || curField || source,
        pad: str(padRaw) || curPad || 'без куста',
        n: str(wellRaw),
        order: num(at(row, 'order')),
        type: str(at(row, 'type')), purpose: str(at(row, 'purpose')),
        depth: num(at(row, 'depth')), dd: num(at(row, 'dd')), bd: num(at(row, 'bd')), speed: num(at(row, 'speed')),
        rig: str(at(row, 'rig')), crew: normCrew(at(row, 'crew')),
        frp: num(at(row, 'frp')), gnkt: num(at(row, 'gnkt')),
        ph: {}
      };
      for (var gk in phaseCols) {
        var pc = phaseCols[gk];
        var rec = {
          s: parseDate(pc.s !== undefined ? row[pc.s] : null),
          e: parseDate(pc.e !== undefined ? row[pc.e] : null),
          d: num(pc.d !== undefined ? row[pc.d] : null)
        };
        if (pc.dist !== undefined) rec.dist = num(row[pc.dist]);
        if (!rec.s && !rec.e && !(rec.d > 0)) continue;
        if (!rec.e && rec.s && rec.d > 0) rec.e = addDays(rec.s, rec.d);
        if (!rec.s && rec.e && rec.d > 0) rec.s = addDays(rec.e, -rec.d);
        if (SECTION_ORDER.indexOf(gk) >= 0) (w.ph.sections = w.ph.sections || []).push({ k: gk, s: rec.s, e: rec.e, d: rec.d });
        else w.ph[gk] = rec;
      }
      // интервал бурения: «цикл бурения» заполнен у всех скважин, блок «Бурение» — не у всех
      var dr = w.ph.drill || {};
      w.ds = parseDate(at(row, 'cycS')) || dr.s || null;
      w.de = parseDate(at(row, 'cycE')) || dr.e || (w.ds && w.dd ? addDays(w.ds, w.dd) : null) || w.ds;
      if (w.ds && w.de && t(w.de) < t(w.ds)) w.de = w.ds;
      if (!w.ph.drill && w.ds) w.ph.drill = { s: w.ds, e: w.de, d: w.dd };   // для ковра куста
      w.padKey = source + '|' + w.pad;
      wells.push(w);
    }
    if (!wells.length) throw new Error('«' + source + '»: в файле не нашлось строк со скважинами.');

    var counts = {};
    wells.forEach(function (w) { counts[w.field] = (counts[w.field] || 0) + 1; });
    var fields = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    return { source: source, fields: fields, wells: wells };
  }

  /** Кусты файлов для режимов «по скважинам куста»: ключ — файл + куст (одноимённые кусты разных месторождений не сливаются). */
  function padsOf(files) {
    var by = {}, out = [];
    files.forEach(function (f) {
      f.wells.forEach(function (w) {
        if (!by[w.padKey]) { by[w.padKey] = { key: w.padKey, name: w.pad, field: w.field, source: f.source, wells: [] }; out.push(by[w.padKey]); }
        by[w.padKey].wells.push(w);
      });
    });
    out.forEach(function (p) {
      p.wells.sort(function (a, b) {
        var ao = a.order != null ? a.order : Infinity, bo = b.order != null ? b.order : Infinity;
        if (ao !== bo) return ao - bo;
        return (t(a.ds) || Infinity) - (t(b.ds) || Infinity);
      });
    });
    return out;
  }

  /* ---------------- график движения буровых установок ---------------- */
  /**
   * Установка = файл (секция месторождения) + номер бригады. Номера бригад в графиках ведутся внутри
   * месторождения: бригада 4 на одном месторождении и бригада 4 на другом бурят одновременно — это разные установки.
   * «Наименование вида БУ» не годится в ключ: у одной бригады оно меняется посреди куста.
   *
   * Кампания — подряд идущие скважины одной установки на одном кусте: начало — начало бурения первой,
   * конец — окончание бурения последней. Между кампаниями — ВМР: демонтаж, переезд, монтаж по датам графика;
   * то, что датами не покрыто, — простой установки.
   */
  function buildSchedule(files, opts) {
    opts = opts || {};
    var sections = [], warnings = [], undated = 0;
    files.forEach(function (f) {
      var by = {}, keys = [];
      f.wells.forEach(function (w) {
        var key = w.crew ? 'бр. ' + w.crew : 'БУ ' + (w.rig || 'не указана');
        if (!by[key]) { by[key] = { key: f.source + '|' + key, crew: w.crew, wells: [], undated: [] }; keys.push(key); }
        by[key][w.ds ? 'wells' : 'undated'].push(w);
      });
      var rigs = keys.filter(function (k) { return by[k].wells.length; }).map(function (k) {
        var rig = buildRig(by[k], f, warnings);
        // скважины без дат бурения: в ГДБУ они входят в число скважин куста — присоединяем к кампании этого куста
        by[k].undated.forEach(function (w) {
          var same = rig.camps.filter(function (c) { return c.padKey === w.padKey; });
          if (same.length) { same[same.length - 1].undated.push(w); same[same.length - 1].n++; rig.wellsN++; }
          else undated++;
        });
        return rig;
      });
      keys.forEach(function (k) { if (!by[k].wells.length) undated += by[k].undated.length; });
      rigs.sort(function (a, b) { return t(a.camps[0].s) - t(b.camps[0].s); });
      sections.push({ id: f.source, title: f.fields.join(' · '), source: f.source, rigs: rigs });
    });
    var a = null, b = null;
    sections.forEach(function (s) {
      s.rigs.forEach(function (r) {
        r.camps.forEach(function (c) {
          if (a == null || t(c.s) < a) a = t(c.s);
          if (b == null || t(c.e) > b) b = t(c.e);
        });
      });
    });
    return { sections: sections, warnings: warnings, undated: undated, range: a == null ? null : { a: iso(a), b: iso(b) } };
  }

  function buildRig(g, file, warnings) {
    var ws = g.wells.slice().sort(function (a, b) {
      return (t(a.ds) - t(b.ds)) || ((a.order || 0) - (b.order || 0));
    });
    var types = {};
    ws.forEach(function (w) { if (w.rig) types[w.rig] = (types[w.rig] || 0) + 1; });
    var typeList = Object.keys(types).sort(function (a, b) { return types[b] - types[a]; });

    var camps = [];
    ws.forEach(function (w) {
      var last = camps[camps.length - 1];
      if (last && last.padKey === w.padKey) {
        last.wells.push(w);
        if (t(w.de) > t(last.e)) last.e = w.de;
      } else {
        camps.push({ pad: w.pad, padKey: w.padKey, field: w.field, wells: [w], s: w.ds, e: w.de });
      }
    });
    camps.forEach(function (c) {
      c.undated = [];
      c.n = c.wells.length;
      c.drillDays = c.wells.reduce(function (s, w) { return s + (w.dd || 0); }, 0);
      c.types = {};
      c.wells.forEach(function (w) { if (w.rig) c.types[w.rig] = 1; });
    });

    var label = g.crew ? 'бригада ' + g.crew : (typeList[0] || 'БУ не указана');
    var gaps = [];
    for (var i = 0; i + 1 < camps.length; i++) {
      var p = camps[i], n = camps[i + 1];
      var a = t(p.e), b = t(n.s), days = (b - a) / DAY;
      if (days < -0.5) {
        warnings.push({ kind: 'conflict', section: file.source, rig: label,
          text: label + ': КП ' + n.pad + ' начат ' + n.s + ', пока КП ' + p.pad + ' бурится до ' + p.e + ' — установка не может быть на двух кустах' });
        continue;
      }
      if (days < 1) {
        warnings.push({ kind: 'novmr', section: file.source, rig: label,
          text: label + ': переход КП ' + p.pad + ' → КП ' + n.pad + ' без времени на ВМР (' + p.e + ' → ' + n.s + ')' });
      }
      gaps.push(gapParts(p, n, a, b));
    }
    return { key: g.key, section: file.source, crew: g.crew, label: label, rigType: typeList[0] || '', rigTypes: typeList,
             camps: camps, gaps: gaps,
             wellsN: ws.length, idleDays: gaps.reduce(function (s, x) { return s + x.idle; }, 0),
             vmrDays: gaps.reduce(function (s, x) { return s + x.days; }, 0) };
  }

  /** Работы ВМР по датам графика внутри промежутка между кустами; непокрытое — простой. */
  function gapParts(prev, next, a, b) {
    var last = prev.wells[prev.wells.length - 1], first = next.wells[0];
    var cand = [
      { k: 'demount', label: 'демонтаж', rec: last.ph.demount },
      { k: 'skid', label: 'стаскивание', rec: last.ph.skid },
      { k: 'reloc', label: 'переезд', rec: last.ph.reloc },
      { k: 'mount', label: 'монтаж', rec: first.ph.mount }
    ];
    var parts = [];
    cand.forEach(function (c) {
      if (!c.rec || !c.rec.s || !c.rec.e) return;
      var s = Math.max(a, t(c.rec.s)), e = Math.min(b, t(c.rec.e));
      if (e - s >= DAY / 2) parts.push({ k: c.k, label: c.label, a: s, b: e, days: (e - s) / DAY });
    });
    parts.sort(function (x, y) { return x.a - y.a; });
    // объединение интервалов — сколько дней промежутка закрыто работами
    var covered = 0, ca = null, cb = null;
    parts.forEach(function (p) {
      if (ca == null || p.a > cb) { if (ca != null) covered += cb - ca; ca = p.a; cb = p.b; }
      else cb = Math.max(cb, p.b);
    });
    if (ca != null) covered += cb - ca;
    var days = Math.max(0, (b - a) / DAY), cov = Math.min(days, covered / DAY);
    return { from: prev.pad, to: next.pad, a: iso(a), b: iso(b), days: days, parts: parts,
             covered: cov, idle: parts.length ? Math.max(0, days - cov) : 0, hasData: parts.length > 0 };
  }

  /* ---------------- сверка с эталонным ГДБУ (для тестов) ---------------- */
  function padNorm(p) {
    return norm(p).replace(/уплотняющий/g, 'упл').replace(/в\/з\s*скважин/g, 'вс')
      .replace(/кп|№|куст/g, '').replace(/[\s\-.]/g, '');
  }

  var api = {
    DAY: DAY, parseDate: parseDate, t: t, iso: iso, addDays: addDays, normCrew: normCrew, norm: norm,
    findHeader: findHeader, parseRows: parseRows, padsOf: padsOf, buildSchedule: buildSchedule, padNorm: padNorm,
    SECTION_ORDER: SECTION_ORDER
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CarpetCore = api;
})(this);
