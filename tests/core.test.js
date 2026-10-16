/* Тесты ядра. Итог пишется в #out и в window.__testResult = {passed, failed}. */
(function () {
  'use strict';
  var C = window.CarpetCore, out = document.getElementById('out');
  var passed = 0, failed = 0;
  function log(html) { out.insertAdjacentHTML('beforeend', html); }
  function check(name, cond, detail) {
    if (cond) { passed++; log('<div class="ok">✓ ' + name + '</div>'); }
    else { failed++; log('<div class="fail">✗ ' + name + (detail ? ' — ' + detail : '') + '</div>'); }
  }

  /* ---------- синтетика ---------- */
  // Шапка как в выгрузке: строка блоков (объединённые ячейки) и строка заголовков; бригада '04' = 4.
  var head0 = ['Параметры скважины', null, null, null, null, null, null, 'Бурение', null, null, 'Монтаж', null, null, 'Демонтаж', null, null];
  var head1 = ['Порядок бурения скважины', 'Куст', 'Номер скважины', 'Номер бригады', 'Наименование вида БУ', 'Месторождение',
    'Дата начала цикла бурения', 'Дата начала', 'Дата окончания', 'Количество дней', 'Дата начала', 'Дата окончания', 'Количество дней',
    'Дата начала', 'Дата окончания', 'Количество дней'];
  function well(o, pad, n, crew, rig, cyc, drill, mount, demount) {
    return [o, pad, n, crew, rig, 'Поле А', cyc, drill && drill[0], drill && drill[1], null,
      mount && mount[0], mount && mount[1], null, demount && demount[0], demount && demount[1], null];
  }
  var rowsA = [head0, head1, [null, 'Поле А'], [null, '1'],
    well(1, null, '101', '04', 'БУ 5000', null, ['2024-01-10', '2024-02-01'], ['2023-12-01', '2024-01-10']),
    well(2, null, '102', 4, 'ZJ-40', null, ['2024-02-03', '2024-02-25']),          // тип БУ сменился — бригада та же
    well(3, null, '103', '04', 'БУ 5000', null, null, null, ['2024-03-01', '2024-03-10']),
    [null, '2'],
    well(4, null, '201', '04', 'БУ 5000', null, ['2024-05-01', '2024-05-20'], ['2024-03-20', '2024-05-01']),
    well(5, null, '202', '7', 'БУ 4500', null, ['2024-01-05', '2024-01-30'])
  ];
  // у скважины 103 нет блока «Бурение» — даты из «Дата начала цикла бурения» + «Цикл бурения» нет → берём блок? нет: проверим цикл
  rowsA[6][6] = '2024-02-26';   // цикл бурения начат, окончание по блоку отсутствует → конец = начало
  var fA = C.parseRows(rowsA, 'A');
  check('разделитель «Поле А» — месторождение, а не куст', fA.wells.every(function (w) { return w.pad !== 'Поле А'; }) && fA.wells[0].field === 'Поле А');
  check('скважины кустов 1 и 2', fA.wells.filter(function (w) { return w.pad === '1'; }).length === 3 && fA.wells.filter(function (w) { return w.pad === '2'; }).length === 2);
  check('бригада «04» = 4', fA.wells[0].crew === '4' && fA.wells[1].crew === '4');
  check('скважина без блока «Бурение» берёт «Дату начала цикла бурения»', fA.wells[2].ds === '2024-02-26', fA.wells[2].ds);
  var sA = C.buildSchedule([fA]);
  var r4 = sA.sections[0].rigs.filter(function (r) { return r.crew === '4'; })[0];
  check('одна строка на бригаду 4, хотя вид БУ меняется', sA.sections[0].rigs.length === 2 && r4 && r4.camps.length === 2,
    sA.sections[0].rigs.map(function (r) { return r.label + ':' + r.camps.length; }).join(', '));
  check('начало кампании — начало бурения, а не монтажа', r4 && r4.camps[0].s === '2024-01-10', r4 && r4.camps[0].s);
  check('конец кампании — окончание бурения последней скважины', r4 && r4.camps[0].e === '2024-02-26', r4 && r4.camps[0].e);
  var g = r4 && r4.gaps[0];
  check('ВМР между КП 1 и КП 2 = 65 дней', g && Math.round(g.days) === 65, g && g.days);
  check('ВМР: демонтаж 9 + монтаж 42 дня покрыты работами, простой 14', g && Math.round(g.covered) === 51 && Math.round(g.idle) === 14,
    g && (g.covered + ' / ' + g.idle));

  // конфликт: одна бригада одновременно на двух кустах
  var rowsB = [head0, head1, [null, '5'],
    well(1, null, '501', '9', 'БУ', null, ['2024-01-01', '2024-02-01']),
    [null, '6'], well(1, null, '601', '9', 'БУ', null, ['2024-01-15', '2024-02-10'])];
  var sB = C.buildSchedule([C.parseRows(rowsB, 'B')]);
  check('пересечение кустов у одной бригады → предупреждение', sB.warnings.some(function (w) { return w.kind === 'conflict'; }));
  // одноимённые бригады в разных файлах — разные установки
  var sAB = C.buildSchedule([fA, C.parseRows(rowsB, 'B')]);
  check('бригады разных месторождений не сливаются', sAB.sections.length === 2 && sAB.sections[1].rigs[0].key === 'B|бр. 9');

  /* ---------- сверка с эталонным ГДБУ ---------- */
  function load(name) {
    return fetch('../data/fixtures/' + name).then(function (r) { if (!r.ok) throw new Error(name); return r.json(); });
  }
  Promise.all([load('vpu.json'), load('tpu.json'), load('gdbu.json')]).then(function (res) {
    var files = [C.parseRows(res[0].rows, 'ВПУ'), C.parseRows(res[1].rows, 'ТПУ')];
    var sched = C.buildSchedule(files);
    var map = { 'Ванкор': 'ВПУ', 'Тагул': 'ТПУ' };
    var FACT_END = '2024-01-01';   // ГДБУ собран по другой версии плана: строго сверяем только факт
    var total = 0, seqOk = 0, start = 0, end = 0, cnt = 0, fact = 0, factOk = 0, missingRigs = [], unmatched = [];
    res[2].sections.forEach(function (gs) {
      var sec = sched.sections.filter(function (s) { return s.id === map[gs.name]; })[0];
      if (!sec) return;
      var rows = [];
      gs.rows.forEach(function (gr) {
        var rig = sec.rigs.filter(function (r) { return r.crew === gr.crew; })[0];
        if (!rig) { missingRigs.push(gs.name + ' бр. ' + gr.crew); return; }
        var lastIdx = -1;
        gr.campaigns.forEach(function (gc) {
          if (!gc.start) return;
          var cands = rig.camps.map(function (c, i) { return { c: c, i: i }; })
            .filter(function (x) { return C.padNorm(x.c.pad) === C.padNorm(gc.pad); });
          if (!cands.length) { unmatched.push(gs.name + ' бр. ' + gr.crew + ' КП ' + gc.pad + ' ' + gc.start); return; }
          var best = cands.sort(function (x, y) { return Math.abs(C.t(x.c.s) - C.t(gc.start)) - Math.abs(C.t(y.c.s) - C.t(gc.start)); })[0];
          total++;
          if (best.i > lastIdx) seqOk++;
          lastIdx = best.i;
          var ds = Math.round((C.t(best.c.s) - C.t(gc.start)) / C.DAY);
          var de = gc.end ? Math.round((C.t(best.c.e) - C.t(gc.end)) / C.DAY) : null;
          var okS = Math.abs(ds) <= 1, okE = de != null && Math.abs(de) <= 1, okN = best.c.n === gc.wells;
          start += okS; end += okE; cnt += okN;
          var isFact = gc.end && gc.end < FACT_END;
          if (isFact) { fact++; factOk += (okS && okE && okN); }
          rows.push('<tr class="' + (isFact && !(okS && okE && okN) ? 'bad' : '') + '"><td>' + gr.crew + '</td><td>' + gc.pad + '</td><td>' +
            gc.start + ' … ' + gc.end + ' (' + gc.wells + ')</td><td>' + best.c.s + ' … ' + best.c.e + ' (' + best.c.n + ')</td><td>' +
            ds + '</td><td>' + (de == null ? '' : de) + '</td><td>' + (isFact ? 'факт' : 'план') + '</td></tr>');
        });
      });
      log('<h3>' + gs.name + ' ↔ ' + map[gs.name] + '</h3><table><tr><th>бр.</th><th>КП</th><th>ГДБУ</th><th>страница</th>' +
        '<th>Δ нач.</th><th>Δ кон.</th><th></th></tr>' + rows.join('') + '</table>');
    });
    log('<p>Кампаний сопоставлено: ' + total + '; порядок кустов у бригады совпал: ' + seqOk + '; начало ±1 день: ' + start +
      '; конец ±1 день: ' + end + '; число скважин: ' + cnt + '.<br>Факт (до ' + FACT_END + '): ' + factOk + ' из ' + fact + ' совпали полностью.</p>');
    if (missingRigs.length) log('<p class="skip">Бригад ГДБУ нет в графиках бурения: ' + missingRigs.join(', ') + '</p>');
    if (unmatched.length) log('<p class="skip">Кустов ГДБУ не нашлось у бригады (' + unmatched.length + '): ' + unmatched.slice(0, 30).join('; ') + '</p>');
    check('порядок кустов у каждой бригады совпадает с ГДБУ', total > 0 && seqOk === total, seqOk + ' из ' + total);
    check('фактические кампании совпадают с ГДБУ (даты ±1 день и число скважин)', fact > 0 && factOk / fact >= 0.95, factOk + ' из ' + fact);
    check('нет пересечений кустов у одной бригады', !sched.warnings.some(function (w) { return w.kind === 'conflict'; }),
      sched.warnings.filter(function (w) { return w.kind === 'conflict'; }).slice(0, 3).map(function (w) { return w.text; }).join('; '));
    finish();
  }).catch(function (e) {
    log('<p class="skip">Сверка с ГДБУ пропущена: нет фикстур (' + e.message + ').</p>');
    finish();
  });

  function finish() {
    log('<h2 class="' + (failed ? 'fail' : 'ok') + '">Итог: ' + passed + ' прошло, ' + failed + ' упало</h2>');
    window.__testResult = { passed: passed, failed: failed };
  }
})();
