<?php
// Same-origin proxy for the /idgames archive.
//
// The browser can't talk to idgames mirrors directly: they send no CORS
// headers and the game page is COEP: require-corp. This endpoint:
//   ?action=search&q=<text>&type=title|filename|author|description
//   ?action=latest
//   ?action=get&id=<int>      -> downloads + extracts the zip (cached),
//                                returns JSON incl. the playable files
//   ?action=file&id=<int>&name=<file>  -> streams one extracted file
//
// Only hosts in $MIRRORS / $API are ever contacted, and only the numeric
// id from the client is trusted; dir/filename come from the API response.

declare(strict_types=1);

const API = 'https://www.doomworld.com/idgames/api/api.php';
const MIRRORS = [
    'https://youfailit.net/pub/idgames/',
    'https://www.quaddicted.com/files/idgames/',
];
const MAX_ZIP_BYTES   = 150 * 1024 * 1024;
const MAX_EXTRACT     = 300 * 1024 * 1024;
const PLAYABLE_EXT    = ['wad', 'pk3', 'pk7', 'ipk3', 'deh', 'bex'];
const INFO_EXT        = ['txt'];

$cacheRoot = getenv('IDGAMES_CACHE') ?: sys_get_temp_dir() . '/uzdoom-idgames';
@mkdir($cacheRoot, 0775, true);

header('Cross-Origin-Resource-Policy: same-origin');

function fail(int $code, string $msg): never {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode(['error' => $msg]);
    exit;
}

function http_get(string $url, ?string $toFile = null, int $max = 0): string|bool {
    $ch = curl_init($url);
    $fh = $toFile ? fopen($toFile, 'wb') : null;
    $opts = [
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT        => 120,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_USERAGENT      => 'uzdoom-wasm-launcher/1.0',
        CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS,
    ];
    if ($fh) {
        $opts[CURLOPT_FILE] = $fh;
        if ($max) {
            $opts[CURLOPT_NOPROGRESS] = false;
            $opts[CURLOPT_PROGRESSFUNCTION] =
                fn($r, $dt, $dl) => $dl > $max ? 1 : 0;
        }
    } else {
        $opts[CURLOPT_RETURNTRANSFER] = true;
    }
    curl_setopt_array($ch, $opts);
    $res = curl_exec($ch);
    $ok = $res !== false && curl_getinfo($ch, CURLINFO_RESPONSE_CODE) === 200;
    curl_close($ch);
    if ($fh) fclose($fh);
    return $toFile ? $ok : ($ok ? $res : false);
}

function api(array $params): array {
    $params['out'] = 'json';
    $body = http_get(API . '?' . http_build_query($params));
    if ($body === false) fail(502, 'idgames API unreachable');
    $j = json_decode($body, true);
    if (!is_array($j)) fail(502, 'bad API response');
    return $j;
}

function shape(array $f): array {
    return [
        'id'     => (int)$f['id'],
        'title'  => $f['title'] ?? '',
        'author' => $f['author'] ?? '',
        'desc'   => $f['description'] ?? '',
        'size'   => (int)($f['size'] ?? 0),
        'date'   => $f['date'] ?? '',
        'rating' => $f['rating'] ?? null,
        'dir'    => $f['dir'] ?? '',
        'filename' => $f['filename'] ?? '',
    ];
}

function file_list(array $j): array {
    $f = $j['content']['file'] ?? [];
    if ($f && array_keys($f) !== range(0, count($f) - 1)) $f = [$f]; // single object
    return array_map('shape', $f);
}

function safe_name(string $n): bool {
    return (bool)preg_match('/^[A-Za-z0-9_.\- ]{1,100}$/', $n) && $n[0] !== '.';
}

function ext_of(string $n): string { return strtolower(pathinfo($n, PATHINFO_EXTENSION)); }


// ---- Known free IWADs hosted on GitHub releases ------------------------
// Release assets have no CORS headers, so the browser can't fetch them
// itself. This is a pure pass-through: bytes go upstream -> client with
// nothing written to disk. The client unzips and caches them.
const IWADS = [
    'freedm' => [
        'title' => 'FreeDM', 'desc' => 'Freedoom deathmatch IWAD (Doom II-compatible, free license)',
        'url' => 'https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedm-0.13.0.zip',
        'member' => 'freedm-0.13.0/freedm.wad', 'out' => 'freedm.wad', 'size' => 11331651,
    ],
    // Official id/Raven 4-level demo from the idgames mirror (plain HEXEN.WAD inside).
    'hexdemo' => [
        'title' => 'Hexen demo', 'desc' => 'Raven/id official 4-level Hexen demo (free to distribute)',
        'url' => 'https://youfailit.net/pub/idgames/idstuff/hexen/hexndemo.zip', 'direct' => true,
        'member' => 'HEXEN.WAD', 'out' => 'hexdemo.wad', 'size' => 5664734,
    ],
    // 1994 DOS installer: two DEICE floppy slices (zip each) that the browser
    // joins into a self-extracting zip holding HERETIC1.WAD.
    'hereticsw' => [
        'title' => 'Heretic shareware', 'desc' => 'Raven/id Heretic episode 1 (free to distribute)',
        'direct' => true, 'member' => 'HERETIC1.WAD', 'out' => 'heretic1.wad', 'size' => 2878936,
        'parts' => [
            ['url' => 'https://youfailit.net/pub/idgames/idstuff/heretic/heretic1.zip', 'member' => 'htic_v10.1', 'size' => 1456016],
            ['url' => 'https://youfailit.net/pub/idgames/idstuff/heretic/heretic2.zip', 'member' => 'htic_v10.2', 'size' => 1422920],
        ],
    ],
    'blasphemer' => [
        'title' => 'Blasphemer', 'desc' => 'Free Heretic-compatible IWAD',
        'url' => 'https://github.com/Blasphemer/blasphemer/releases/download/v0.1.8/blasphem-0.1.8.zip',
        'member' => 'blasphem.wad', 'out' => 'blasphem.wad', 'size' => 7601799,
    ],
];

if (($_GET['action'] ?? '') === 'iwads') {
    header('Content-Type: application/json');
    $strip = function ($v) { if (isset($v['parts'])) $v['parts'] = array_map(fn($p) => array_diff_key($p, ['url' => 1]), $v['parts']); return $v; };
    echo json_encode(['iwads' => array_map(
        fn($k, $v) => ['key' => $k] + array_diff_key($v, ['url' => 1, 'direct' => 1])
            + []  /* parts urls stripped below */,
        array_keys(IWADS), array_map($strip, IWADS))]);
    exit;
}

if (($_GET['action'] ?? '') === 'iwad') {
    $e = IWADS[$_GET['key'] ?? ''] ?? null;
    if (!$e) fail(404, 'unknown iwad');

    $loc = null;
    if (!empty($e['direct'])) {
        // Allowlisted mirror that serves the file without redirecting.
        $loc = isset($e['parts']) ? ($e['parts'][(int)($_GET['part'] ?? 0)]['url'] ?? null) : $e['url'];
        if (!$loc) fail(400, 'bad part');
    } else {
    // Hop 1: github.com -> 302 to a signed asset URL. Follow only to GitHub hosts.
    $ch = curl_init($e['url']);
    curl_setopt_array($ch, [
        CURLOPT_NOBODY => true, CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => 15, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_USERAGENT => 'uzdoom-wasm-launcher/1.0',
        CURLOPT_HEADERFUNCTION => function ($c, $h) use (&$loc) {
            if (stripos($h, 'location:') === 0) $loc = trim(substr($h, 9));
            return strlen($h);
        },
    ]);
    curl_exec($ch); curl_close($ch);
    $host = $loc ? parse_url($loc, PHP_URL_HOST) : null;
    if (!$host || !preg_match('/(^|\.)githubusercontent\.com$/', $host)
        || parse_url($loc, PHP_URL_SCHEME) !== 'https') fail(502, 'unexpected upstream redirect');
    }

    // Hop 2: stream straight through.
    while (ob_get_level()) ob_end_clean();
    header('Content-Type: application/zip');
    header('Cache-Control: no-store');
    $sentLen = false;
    $ch = curl_init($loc);
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 300,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_USERAGENT => 'uzdoom-wasm-launcher/1.0',
        CURLOPT_HEADERFUNCTION => function ($c, $h) use (&$sentLen) {
            if (stripos($h, 'content-length:') === 0 && !$sentLen) {
                header('Content-Length: ' . (int)trim(substr($h, 15))); $sentLen = true;
            }
            return strlen($h);
        },
        CURLOPT_WRITEFUNCTION => function ($c, $d) { echo $d; flush(); return strlen($d); },
    ]);
    curl_exec($ch); curl_close($ch);
    exit;
}

$action = $_GET['action'] ?? '';

if ($action === 'search') {
    $q = trim((string)($_GET['q'] ?? ''));
    $type = $_GET['type'] ?? 'title';
    if (!in_array($type, ['title', 'filename', 'author', 'description', 'textfile'], true)) $type = 'title';
    if (strlen($q) < 3) fail(400, 'query must be at least 3 characters');
    $j = api(['action' => 'search', 'query' => $q, 'type' => $type, 'sort' => 'rating', 'dir' => 'desc']);
    header('Content-Type: application/json');
    echo json_encode(['results' => file_list($j)]);
    exit;
}

if ($action === 'browse') {
    $d = (string)($_GET['dir'] ?? '');
    if (!preg_match('#^[A-Za-z0-9_\-]+(/[A-Za-z0-9_.\- ]+)*/$#', $d) || str_contains($d, '..')) fail(400, 'bad dir');
    $cf = "$cacheRoot/browse-" . md5($d) . '.json';
    if (is_file($cf) && filemtime($cf) > time() - 3600) { header('Content-Type: application/json'); readfile($cf); exit; }
    $j = api(['action' => 'getcontents', 'name' => $d]);
    $dirs = $j['content']['dir'] ?? [];
    if ($dirs && array_keys($dirs) !== range(0, count($dirs) - 1)) $dirs = [$dirs];
    $out = json_encode([
        'dir'  => $d,
        'dirs' => array_values(array_map(fn($x) => $x['name'], $dirs)),
        'results' => file_list($j),
    ]);
    file_put_contents($cf, $out);
    header('Content-Type: application/json');
    echo $out;
    exit;
}

if ($action === 'latest') {
    $j = api(['action' => 'latestfiles', 'limit' => 30]);
    header('Content-Type: application/json');
    echo json_encode(['results' => file_list($j)]);
    exit;
}

if ($action === 'get' || $action === 'file') {
    $id = (int)($_GET['id'] ?? 0);
    if ($id <= 0) fail(400, 'bad id');
    $dir = "$cacheRoot/$id";
    $meta = "$dir/meta.json";

    if (!is_file($meta)) {
        $j = api(['action' => 'get', 'id' => $id]);
        $f = $j['content'] ?? null;
        if (!$f || empty($f['filename'])) fail(404, 'not found');
        $info = shape($f);
        $d = $info['dir']; $fn = $info['filename'];
        if (!preg_match('#^[A-Za-z0-9_./\-]+/$#', $d) || str_contains($d, '..') || !safe_name($fn)
            || ext_of($fn) !== 'zip') fail(422, 'unsupported entry');
        if ($info['size'] > MAX_ZIP_BYTES) fail(413, 'archive too large');

        @mkdir($dir, 0775, true);
        $zipPath = "$dir/src.zip";
        $got = false;
        foreach (MIRRORS as $m) {
            if (http_get($m . $d . rawurlencode($fn), $zipPath, MAX_ZIP_BYTES)) { $got = true; break; }
        }
        if (!$got) { @unlink($zipPath); fail(502, 'mirror download failed'); }

        $zip = new ZipArchive();
        if ($zip->open($zipPath) !== true) fail(422, 'bad zip');
        $files = []; $total = 0;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $st = $zip->statIndex($i);
            $base = basename($st['name']);          // flatten; drops any ../
            if (substr($st['name'], -1) === '/' || !safe_name($base)) continue;
            $ext = ext_of($base);
            if (!in_array($ext, PLAYABLE_EXT, true) && !in_array($ext, INFO_EXT, true)) continue;
            $total += $st['size'];
            if ($total > MAX_EXTRACT) fail(413, 'extracted size too large');
            $out = "$dir/" . strtolower($base);
            file_put_contents($out, $zip->getFromIndex($i));
            $files[strtolower($base)] = ['name' => strtolower($base), 'size' => $st['size'],
                                         'kind' => in_array($ext, INFO_EXT, true) ? 'info' : 'play'];
        }
        $zip->close();
        @unlink($zipPath);
        $info['files'] = array_values($files);
        file_put_contents($meta, json_encode($info));
    }

    $info = json_decode(file_get_contents($meta), true);
    if ($action === 'get') {
        header('Content-Type: application/json');
        echo json_encode($info);
        exit;
    }

    $name = strtolower((string)($_GET['name'] ?? ''));
    $known = array_column($info['files'], 'name');
    if (!in_array($name, $known, true)) fail(404, 'no such file');
    $path = "$dir/$name";
    header('Content-Type: ' . (ext_of($name) === 'txt' ? 'text/plain; charset=utf-8' : 'application/octet-stream'));
    header('Content-Length: ' . filesize($path));
    header('Cache-Control: public, max-age=86400');
    readfile($path);
    exit;
}

fail(400, 'unknown action');
