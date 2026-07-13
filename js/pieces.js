/*
 * SigmaBoy — original flat SVG chess piece set (viewBox 0 0 45 45)
 */
(function (global) {
'use strict';

const STYLE = {
  w: { fill: '#f5f3ef', stroke: '#3d3a36', accent: '#3d3a36' },
  b: { fill: '#3a3733', stroke: '#14120f', accent: '#f0ede8' },
};

const BASE = 'M 12,36.5 C 12,34.8 14.2,33.6 16.5,33 L 28.5,33 C 30.8,33.6 33,34.8 33,36.5 L 33,39 L 12,39 Z';

function bodyParts(c) {
  return { fill: c.fill, stroke: c.stroke, accent: c.accent };
}

const SHAPES = {
  p(c) {
    return `
      <circle cx="22.5" cy="12.5" r="5" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6"/>
      <path d="M 19.5,16.5 C 17,19 16.5,22.5 17.8,26 L 15.5,29 C 13.5,31 12.5,33.5 12.5,36 L 12.5,39 L 32.5,39 L 32.5,36 C 32.5,33.5 31.5,31 29.5,29 L 27.2,26 C 28.5,22.5 28,19 25.5,16.5 Z"
        fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>`;
  },
  r(c) {
    return `
      <path d="M 11.5,10 L 15.5,10 L 15.5,13 L 19.5,13 L 19.5,10 L 25.5,10 L 25.5,13 L 29.5,13 L 29.5,10 L 33.5,10 L 33.5,16 L 31,18.5 L 31,30 L 33,32.5 L 33,35 L 12,35 L 12,32.5 L 14,30 L 14,18.5 L 11.5,16 Z"
        fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M 12,35 L 33,35 L 33,39 L 12,39 Z" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M 14,18.5 L 31,18.5 M 14,30 L 31,30" fill="none" stroke="${c.stroke}" stroke-width="1.2"/>`;
  },
  n(c) {
    return `
      <path d="M 13,39 C 13,31.5 15.5,27.5 19.5,25 C 16.8,24 15.3,21.5 15.9,18.8 C 16.3,17 17.5,15.4 19.2,14.3 L 18.4,9.5 L 22,12.8 C 22.9,12.5 23.9,12.3 24.9,12.3 L 26.3,8.2 L 28,12.9 C 33,15 35.5,19.8 35.5,26 C 35.5,30.8 34.6,35.4 33.5,39 Z"
        fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="21.8" cy="17.8" r="1.3" fill="${c.accent}"/>
      <path d="M 17.5,20.5 C 17.8,21.6 18.6,22.4 19.8,22.8" fill="none" stroke="${c.accent}" stroke-width="1.1" stroke-linecap="round"/>`;
  },
  b(c) {
    return `
      <circle cx="22.5" cy="8" r="2.4" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>
      <path d="M 22.5,10.8 C 27.2,14 29.5,18 29.5,21.7 C 29.5,25 26.6,27.6 22.5,27.6 C 18.4,27.6 15.5,25 15.5,21.7 C 15.5,18 17.8,14 22.5,10.8 Z"
        fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M 22.5,15.5 L 22.5,23 M 19,19.2 L 26,19.2" fill="none" stroke="${c.accent}" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M 18.5,27.6 L 17,33 L 28,33 L 26.5,27.6 Z" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="${BASE}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>`;
  },
  q(c) {
    return `
      <path d="M 11.5,25.5 L 8.5,12.5 L 15.5,19.5 L 18.2,10.5 L 22.5,18.2 L 26.8,10.5 L 29.5,19.5 L 36.5,12.5 L 33.5,25.5 Z"
        fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="8.5" cy="11.5" r="1.8" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.3"/>
      <circle cx="18.2" cy="9" r="1.8" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.3"/>
      <circle cx="22.5" cy="7.5" r="1.8" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.3"/>
      <circle cx="26.8" cy="9" r="1.8" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.3"/>
      <circle cx="36.5" cy="11.5" r="1.8" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.3"/>
      <path d="M 12,25.5 L 33,25.5 L 31.5,30 L 13.5,30 Z" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M 14,30 L 31,30 L 30,33 L 15,33 Z" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="${BASE}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>`;
  },
  k(c) {
    return `
      <path d="M 22.5,5 L 22.5,11 M 19.7,7.8 L 25.3,7.8" fill="none" stroke="${c.stroke}" stroke-width="2" stroke-linecap="round"/>
      <path d="M 22.5,12 C 27.5,12 31.5,15.5 31.5,20.5 C 31.5,24.5 28,27.5 22.5,27.5 C 17,27.5 13.5,24.5 13.5,20.5 C 13.5,15.5 17.5,12 22.5,12 Z"
        fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M 22.5,14.5 C 24.9,14.5 26.8,16.4 26.8,18.8 C 26.8,20.7 25.1,22.3 22.5,22.3 C 19.9,22.3 18.2,20.7 18.2,18.8 C 18.2,16.4 20.1,14.5 22.5,14.5 Z"
        fill="none" stroke="${c.accent}" stroke-width="1.2"/>
      <path d="M 17.5,27.5 L 16.5,33 L 28.5,33 L 27.5,27.5 Z" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="${BASE}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.6" stroke-linejoin="round"/>`;
  },
};

// key: 'wp','wn','wb','wr','wq','wk','bp',...
const CACHE = {};
function pieceSvg(colorChar, typeChar) {
  const key = colorChar + typeChar;
  if (CACHE[key]) return CACHE[key];
  const c = bodyParts(STYLE[colorChar]);
  const svg = `<svg viewBox="0 0 45 45" xmlns="http://www.w3.org/2000/svg">${SHAPES[typeChar](c)}</svg>`;
  CACHE[key] = svg;
  return svg;
}

global.SigmaPieces = { pieceSvg };
})(typeof self !== 'undefined' ? self : globalThis);
