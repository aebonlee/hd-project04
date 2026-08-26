/**
 * 화면 연기 테스트 — node <이 파일>   (playwright 필요)
 *
 * 규칙 테스트가 전부 통과해도 스크립트 오타 하나면 페이지가 **빈 화면**이 된다.
 * 규칙은 맞는데 아무도 그것을 볼 수 없는 상태다. 파일을 읽어서는 안 잡힌다.
 *
 * 여기서는 저장소의 HTML 을 실제로 띄워 이것만 본다.
 *   · 열리는가 (200)
 *   · 자바스크립트 오류 없이 뜨는가
 *   · 화면에 내용이 그려졌는가 (빈 화면이 아닌가)
 *   · 좁은 화면에서 가로로 밀리지 않는가
 *
 * 계산과 규칙은 각 저장소의 단위 테스트가 본다. 여기서는 그것을 다시 보지 않는다.
 * playwright 가 없으면 조용히 건너뛴다 — 이것 하나 때문에 검사 전체가 막히면
 * 아무도 안 돌리게 된다. CI 에서는 설치하고 돌린다.
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var PORT = 8799;

var TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.csv': 'text/csv'
};

var SKIP_DIR = /(^|\/)(\.git|node_modules|__pycache__|supabase|scripts)(\/|$)/;

/*
 * 온전한 페이지인가 — 템플릿 조각을 걸러 낸다.
 * 그것까지 띄우면 "빈 화면"으로 잡혀, 실제 문제가 아닌 것이 매번 빨갛게 뜬다.
 *
 * 여는 태그로는 못 가른다. 조각이 페이지의 **앞쪽 절반**인 경우가 있어
 * <!DOCTYPE html><html><head> 로 멀쩡히 시작한다(hd-project02 의 _parts/head.html).
 * 닫는 </html> 이 있는지로 본다 — 완결된 문서에만 있다.
 *
 * 있는 위치가 아니라 파일이 무엇인지로 가른다. 조각을 두는 폴더 이름은 저장소마다 다르다.
 */
function isPage(full) {
  return /<\/html\s*>/i.test(fs.readFileSync(full, 'utf8'));
}

/* 저장소 안의 HTML 을 찾는다. 한 단계 아래의 하위 앱(dashboard_marketing 등)도 함께 본다. */
function findPages(dir, rel, out) {
  rel = rel || '';
  out = out || [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var r = rel ? rel + '/' + e.name : e.name;
    if (SKIP_DIR.test('/' + r)) return;
    var full = path.join(dir, e.name);
    if (e.isDirectory()) { if (r.split('/').length <= 2) findPages(full, r, out); }
    else if (/\.html$/i.test(e.name) && isPage(full)) out.push(r);
  });
  return out;
}

var pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error('  X ' + label);
  if (detail) console.error('      ' + detail);
}

var chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  console.log('playwright 가 없어 화면 연기 테스트를 건너뜁니다 (CI 에서는 설치 후 돌립니다).');
  process.exit(0);
}

var server = http.createServer(function (req, res) {
  var rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  var file = path.join(ROOT, rel);
  if (file.indexOf(ROOT) !== 0 || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', function () {
  run().then(function () {
    server.close();
    console.log('\n' + (fail ? 'X ' : 'O ') + pass + ' 통과 / ' + fail + ' 실패');
    process.exit(fail ? 1 : 0);
  }).catch(function (e) {
    server.close(); console.error(e); process.exit(1);
  });
});

async function run() {
  var pages = findPages(ROOT).sort();
  if (!pages.length) { console.log('HTML 이 없습니다 — 건너뜁니다.'); return; }

  var launch = {};
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }
  var browser = await chromium.launch(launch);
  var page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  console.log('\n1. 화면이 오류 없이 뜬다');
  for (var i = 0; i < pages.length; i++) {
    var errors = [];
    var onErr = function (e) { errors.push(String(e.message || e)); };
    page.on('pageerror', onErr);

    var res = await page.goto('http://127.0.0.1:' + PORT + '/' + pages[i],
                              { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);

    ok(res && res.status() === 200, pages[i] + ' — 200 으로 열린다');
    ok(errors.length === 0, pages[i] + ' — 자바스크립트 오류가 없다', errors.join(' | '));

    // 빈 화면이 아닌가 — 스크립트가 죽으면 본문이 통째로 비어 있다
    var painted = await page.evaluate(function () {
      var t = (document.body.innerText || '').trim();
      return { chars: t.length, nodes: document.body.querySelectorAll('*').length };
    });
    ok(painted.chars >= 30 && painted.nodes >= 10,
       pages[i] + ' — 화면에 내용이 그려졌다',
       '글자 ' + painted.chars + '자 / 요소 ' + painted.nodes + '개');

    page.off('pageerror', onErr);
  }

  console.log('\n2. 좁은 화면에서 가로로 밀리지 않는다');
  await page.setViewportSize({ width: 390, height: 844 });
  for (var j = 0; j < pages.length; j++) {
    await page.goto('http://127.0.0.1:' + PORT + '/' + pages[j], { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);
    var over = await page.evaluate(function () {
      return document.documentElement.scrollWidth - document.documentElement.clientWidth;
    });
    ok(over <= 1, pages[j] + ' — 390px 에서 가로 스크롤이 없다', over + 'px 넘침');
  }

  await browser.close();
}
