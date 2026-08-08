#!/usr/bin/env node
/*
 * build.js — dashboard.js 를 자체포함 북마크릿으로 변환한다.
 *  1) dashboard.js 를 읽어 가벼운 압축(주석/여백 축소) 후
 *  2) javascript:(function(){ ... })() 형태로 URL 인코딩해 dist/bookmarklet.txt 저장
 *  3) index.html 의 __BOOKMARKLET__ (또는 기존 북마크릿 href) 을 최신 값으로 교체
 *
 * 외부 의존성 없이 Node 표준 모듈만 사용한다(빌드 도구 불필요).
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'dashboard.js');
const OUT = path.join(ROOT, 'dist', 'bookmarklet.txt');
const INDEX = path.join(ROOT, 'index.html');

/** 문자열/정규식/주석을 보존하며 안전하게 최소화하는 간단한 미니파이어. */
function minify(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  let prev = ''; // 직전 의미 있는 문자
  while (i < n) {
    const ch = code[i];
    const two = code.substr(i, 2);
    // 라인 주석
    if (two === '//') { while (i < n && code[i] !== '\n') i++; continue; }
    // 블록 주석
    if (two === '/*') { i += 2; while (i < n && code.substr(i, 2) !== '*/') i++; i += 2; continue; }
    // 문자열
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch; out += ch; i++;
      while (i < n) {
        out += code[i];
        if (code[i] === '\\') { out += code[i + 1]; i += 2; continue; }
        if (code[i] === q) { i++; break; }
        i++;
      }
      prev = q;
      continue;
    }
    // 정규식 리터럴 (직전 토큰이 값이 아닐 때만)
    if (ch === '/' && /[=(,:;!&|?{}\[\n]|^$|return|typeof/.test(prev)) {
      out += ch; i++;
      let inClass = false;
      while (i < n) {
        out += code[i];
        if (code[i] === '\\') { out += code[i + 1]; i += 2; continue; }
        if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        else if (code[i] === '/' && !inClass) { i++; break; }
        i++;
      }
      // 플래그
      while (i < n && /[a-z]/i.test(code[i])) { out += code[i]; i++; }
      prev = '/';
      continue;
    }
    // 공백 처리: 개행/탭/연속공백을 최소화
    if (/\s/.test(ch)) {
      let j = i;
      while (j < n && /\s/.test(code[j])) j++;
      const nextCh = code[j] || '';
      // 식별자/숫자 사이에는 공백 하나 유지
      if (/[A-Za-z0-9_$]/.test(prev) && /[A-Za-z0-9_$]/.test(nextCh)) out += ' ';
      i = j;
      continue;
    }
    out += ch;
    prev = ch;
    i++;
  }
  return out.trim();
}

function main() {
  const raw = fs.readFileSync(SRC, 'utf8');
  const min = minify(raw);

  // 북마크릿 본문: 소스가 이미 IIFE 이므로 그대로 감싼다.
  const body = 'javascript:' + encodeURIComponent(min);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body);
  console.log('dist/bookmarklet.txt  ' + (body.length / 1024).toFixed(1) + ' KB');

  // index.html href 갱신
  let html = fs.readFileSync(INDEX, 'utf8');
  const escaped = body.replace(/"/g, '&quot;');
  html = html.replace(/(<a class="bm" href=")[^"]*(">)/, '$1' + escaped + '$2');
  fs.writeFileSync(INDEX, html);
  console.log('index.html 북마크릿 링크 갱신 완료');
}

main();
