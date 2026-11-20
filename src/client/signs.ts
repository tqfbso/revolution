// Signs for the city (R6, decision 091): shop fronts, street names, hoardings, painted
// with canvas text into one sheet at start-up, then scratched, faded and dirtied. A sign
// is a flat panel on a building that shows one cell of the sheet. They dress the town and
// never play. Every name is made up.
import * as THREE from 'three/webgpu';

/** Cells across and down the sheet; each is four times as wide as it is high. */
export const SIGN_COLS = 4;
export const SIGN_ROWS = 20;
const CW = 256;
const CH = 64;

/** Cell ranges by kind of sign. */
export const SIGN_SHOPS = { from: 0, count: 40 };
export const SIGN_STREETS = { from: 40, count: 12 };
export const SIGN_HOARDINGS = { from: 52, count: 12 };
/** Boards hung out over a Hong Kong street, read top to bottom (the Kowloon map only). */
export const SIGN_TALL = { from: 64, count: 16 };

const TRADES = [
  'BAKERY', 'PHARMACY', 'CAFE', 'GROCER', 'BOOKS', 'HOTEL', 'BANK', 'BUTCHER', 'FLORIST',
  'TAILOR', 'HARDWARE', 'LAUNDRY', 'BARBER', 'MARKET', 'CINEMA', 'POST OFFICE', 'BAR',
  'DAIRY', 'OPTICIAN', 'SHOES', 'CLINIC', 'TOBACCO', 'BICYCLES', 'RADIO REPAIR', 'FURNITURE',
  'PRINTER', 'NOTARY', 'TEA ROOM',
]; // prettier-ignore
const NAMES = [
  'LINDEN', 'MAREK & SON', 'ORLA', 'VESNA', 'BELVEDERE', 'KESTREL', 'OLD MILL', 'NOVAK',
  'THREE BRIDGES', 'HALDEN', 'CENTRAL', 'AURORA', 'PETRA', 'ST. ANSELM', 'UNION', 'RIVERSIDE',
]; // prettier-ignore
const STREETS = [
  'KESTREL STREET', 'MILL LANE', 'FOUNDRY ROAD', 'ST. ANSELM SQ.', 'TANNERS ROW', 'HALDEN AVENUE',
  'STATION ROAD', 'ORCHARD WALK', 'UNION STREET', 'CANAL STREET', 'MARKET PLACE', 'NORTH GATE',
]; // prettier-ignore
const SLOGANS = [
  'DRINK LINDEN TEA', 'AURORA SOAP', 'HALDEN TYRES', 'UNION SAVINGS', 'KESTREL LAGER',
  'RIDE THE TRAM', 'NOVAK PAINTS', 'VISIT THE COAST', 'FRESH BREAD DAILY', 'RADIO AURORA 98',
  'VOTE SUNDAY', 'CIRCUS IN TOWN',
]; // prettier-ignore
// Kowloon (made-up shops; the street names are the real ones of Tsim Sha Tsui and Jordan).
const HK_TRADES = [
  'NOODLES 麵家', 'PAWN 押', 'TAILOR 洋服', 'GOLD 金行', 'PHARMACY 藥房', 'HERBAL TEA 涼茶',
  'MONEY EXCHANGE 找換', 'CAFE 茶餐廳', 'ROAST MEAT 燒臘', 'ELECTRICAL 電器', 'JEWELLERY 珠寶',
  'OPTICAL 眼鏡', 'MAHJONG 麻雀', 'GUEST HOUSE 賓館', 'DIM SUM 點心', 'CONGEE 粥麵',
  'BAKERY 餅家', 'SEAFOOD 海鮮', 'BANK 銀行', 'CLINIC 診所', 'TRAVEL 旅行社', 'SHOES 鞋',
  'WATCHES 鐘錶', 'DRIED SEAFOOD 海味', 'HARDWARE 五金', 'KARAOKE 卡拉OK', 'TEA 茶莊',
  'MOBILE PHONES 手機',
]; // prettier-ignore
const HK_NAMES = [
  'GOLDEN DRAGON 金龍', 'LUCKY 好運', 'MAN KEE 文記', 'LEE KEE 李記', 'SUN WAH 新華', 'TAK SHING 德成',
  'FOOK LAM 福林', 'HOP SING 合成', 'KAM FUNG 金鳳', 'WING LEE 永利', 'TAI PING 太平', 'CHEUNG KEE 祥記',
  'NEW ASIA 新亞', 'GREAT CHINA 大中華', 'OCEAN 海洋', 'PRECIOUS 珍寶',
]; // prettier-ignore
const HK_STREETS = [
  'NATHAN ROAD 彌敦道', 'CANTON ROAD 廣東道', 'HAIPHONG ROAD 海防道', 'PEKING ROAD 北京道',
  'MODY ROAD 麼地道', 'GRANVILLE ROAD 加連威老道', 'KIMBERLEY ROAD 金巴利道', 'AUSTIN ROAD 柯士甸道',
  'SALISBURY ROAD 梳士巴利道', 'CHATHAM ROAD 漆咸道', 'HANKOW ROAD 漢口道', 'ASHLEY ROAD 亞士厘道',
]; // prettier-ignore
const HK_SLOGANS = [
  'KAM FUNG MILK TEA', 'HARBOUR BANK 海港銀行', 'JADE MOBILE', 'DOUBLE HAPPINESS 囍', 'STAR LAGER',
  'DRAGON AIRWAYS', 'GOLDEN HARVEST RICE', 'RIDE THE FERRY 渡輪', 'PEARL SOY SAUCE', 'LUCKY JEWELLERY',
  'SUNRISE PROPERTIES', 'VOTE 投票',
]; // prettier-ignore
/** Vertical boards: two to four characters each. */
const HK_TALL = [
  '押', '金行', '麵家', '涼茶', '茶餐廳', '大藥房', '找換', '珠寶', '洋服', '賓館', '燒臘',
  '麻雀', '海鮮', '診所', '鐘錶', '酒家',
]; // prettier-ignore
/** Their boards: the reds, yellows and greens of the street, all gone dull. */
const HK_BOARDS: [string, string][] = [
  ['#8a2a22', '#e8d9a8'], ['#c9b14a', '#5a1d19'], ['#e2dccb', '#9c2a20'], ['#2f4f3e', '#e9dfb8'],
  ['#28334a', '#e6d9a6'], ['#6a1f2a', '#e8c86a'], ['#d8cfb8', '#1f2a40'], ['#3a2c24', '#d9b45a'],
]; // prettier-ignore
const HK_FONT =
  '"PingFang HK", "PingFang TC", "Noto Sans CJK TC", "Microsoft JhengHei", "WenQuanYi Zen Hei", sans-serif';

/** Board and lettering, as shopkeepers choose them: mostly sober, now and then loud. */
const BOARDS: [string, string][] = [
  ['#1f3d33', '#e9dfc4'], ['#6b1f1c', '#f0e6cf'], ['#1d2c47', '#e8e2d0'], ['#d8cfb8', '#2a2623'],
  ['#2a2826', '#d9b45a'], ['#7a5a24', '#f3ead2'], ['#3f4a55', '#f1ede2'], ['#c9b98a', '#5a1d19'],
  ['#274b5a', '#f2e9d0'], ['#4a2f3c', '#ead9c0'],
]; // prettier-ignore

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return ((s ^ (s >>> 13)) >>> 0) / 4294967296;
  };
}

function fit(
  g: CanvasRenderingContext2D,
  text: string,
  weight: string,
  family: string,
  w: number,
  h: number,
): void {
  let px = h;
  do {
    g.font = `${weight} ${px}px ${family}`;
    px -= 2;
  } while (g.measureText(text).width > w && px > 10);
}

/** Years of weather on one cell: fading, grime from below, scratches, chips. */
function distress(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: () => number,
  hard: number,
): void {
  g.save();
  g.beginPath();
  g.rect(x, y, CW, CH);
  g.clip();
  const fade = g.createLinearGradient(0, y, 0, y + CH);
  fade.addColorStop(0, `rgba(205,200,188,${0.1 * hard})`);
  fade.addColorStop(0.6, 'rgba(60,52,44,0)');
  fade.addColorStop(1, `rgba(40,34,28,${0.5 * hard})`);
  g.fillStyle = fade;
  g.fillRect(x, y, CW, CH);
  // Streaks run down from the top edge.
  for (let k = 0; k < 14 * hard; k++) {
    const sx = x + r() * CW;
    g.fillStyle = `rgba(30,26,22,${0.1 + r() * 0.2})`;
    g.fillRect(sx, y, 1 + r() * 3, CH * (0.3 + r() * 0.7));
  }
  // Scratches, and flakes where the paint has let go.
  g.lineWidth = 1;
  for (let k = 0; k < 10 * hard; k++) {
    g.strokeStyle = `rgba(210,204,190,${0.25 + r() * 0.35})`;
    g.beginPath();
    const sx = x + r() * CW;
    const sy = y + r() * CH;
    g.moveTo(sx, sy);
    g.lineTo(sx + (r() - 0.5) * 70, sy + (r() - 0.5) * 14);
    g.stroke();
  }
  for (let k = 0; k < 26 * hard; k++) {
    g.fillStyle = r() < 0.5 ? 'rgba(120,112,100,0.8)' : 'rgba(58,50,44,0.75)';
    const s = 1 + r() * r() * 9;
    g.fillRect(x + r() * CW, y + r() * CH, s, s * (0.4 + r() * 0.8));
  }
  g.restore();
}

/** The whole sheet, or null where there is no canvas (tests). */
export function makeSigns(hk = false): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = CW * SIGN_COLS;
  canvas.height = CH * SIGN_ROWS;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const r = rng(90210);
  const serif = 'Georgia, "Times New Roman", serif';
  const sans = hk ? HK_FONT : '"Helvetica Neue", Arial, sans-serif';
  const trades = hk ? HK_TRADES : TRADES;
  const names = hk ? HK_NAMES : NAMES;
  const boards = hk ? HK_BOARDS : BOARDS;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let k = 0; k < SIGN_COLS * SIGN_ROWS; k++) {
    const x = (k % SIGN_COLS) * CW;
    const y = Math.floor(k / SIGN_COLS) * CH;
    if (k >= SIGN_TALL.from) {
      // A board for hanging out over the street: characters one under another. The panel
      // is turned on its side, so each one is drawn turned the other way to stand upright.
      const [board, ink] = boards[Math.floor(r() * boards.length)];
      g.fillStyle = board;
      g.fillRect(x, y, CW, CH);
      g.strokeStyle = ink;
      g.lineWidth = 3;
      g.strokeRect(x + 4, y + 4, CW - 8, CH - 8);
      const text = hk ? HK_TALL[(k - SIGN_TALL.from) % HK_TALL.length] : 'HOTEL';
      const chars = [...text];
      const step = Math.min(CH * 1.05, (CW - 24) / chars.length);
      g.fillStyle = ink;
      g.font = `bold ${Math.floor(Math.min(step, CH) * 0.78)}px ${sans}`;
      chars.forEach((ch, n) => {
        g.save();
        // The first character at the top of the board, which is this cell's right-hand end.
        g.translate(x + CW / 2 + ((chars.length - 1) / 2 - n) * step, y + CH / 2);
        g.rotate(Math.PI / 2);
        g.fillText(ch, 0, 2);
        g.restore();
      });
      distress(g, x, y, r, 0.8 + r() * 0.5);
    } else if (k < SIGN_STREETS.from) {
      // A shop fascia: the trade, or a name and the trade, on a painted board.
      const [board, ink] = boards[Math.floor(r() * boards.length)];
      g.fillStyle = board;
      g.fillRect(x, y, CW, CH);
      g.strokeStyle = ink;
      g.globalAlpha = 0.55;
      g.lineWidth = 2;
      g.strokeRect(x + 5, y + 5, CW - 10, CH - 10);
      g.globalAlpha = 1;
      const trade = trades[k % trades.length];
      const text = r() < 0.55 ? trade : `${names[Math.floor(r() * names.length)]} ${trade}`;
      g.fillStyle = ink;
      fit(g, text, r() < 0.5 ? 'bold' : '600', r() < 0.5 ? serif : sans, CW - 30, 38);
      g.fillText(text, x + CW / 2, y + CH / 2 + 2);
      distress(g, x, y, r, 0.7 + r() * 0.6);
    } else if (k < SIGN_HOARDINGS.from) {
      // An enamel street plate: white on deep blue, a rim, a bolt at each end (in Kowloon
      // black on white, the English over the Chinese).
      g.fillStyle = '#b9b5a8';
      g.fillRect(x, y, CW, CH);
      g.fillStyle = hk ? '#dedbd0' : '#17305c';
      g.fillRect(x + 4, y + 4, CW - 8, CH - 8);
      g.strokeStyle = hk ? '#1d1d1b' : '#e6e2d6';
      g.lineWidth = 3;
      g.strokeRect(x + 9, y + 9, CW - 18, CH - 18);
      g.fillStyle = hk ? '#1d1d1b' : '#ece8dc';
      const text = (hk ? HK_STREETS : STREETS)[(k - SIGN_STREETS.from) % STREETS.length];
      fit(g, text, 'bold', sans, CW - 44, 30);
      g.fillText(text, x + CW / 2, y + CH / 2 + 1);
      g.fillStyle = '#8d8a80';
      g.fillRect(x + 13, y + CH / 2 - 2, 4, 4);
      g.fillRect(x + CW - 17, y + CH / 2 - 2, 4, 4);
      distress(g, x, y, r, 0.6);
    } else {
      // A hoarding: a poster in two flat colours, pasted in sheets, peeling.
      const hues = [
        ['#b23a2a', '#f2e3b8'], ['#e0b33c', '#2a2623'], ['#2d5d7a', '#f4ecd6'], ['#3d6b47', '#f0e7c6'],
        ['#e8e0cc', '#a32b22'], ['#28323f', '#e2b24a'],
      ]; // prettier-ignore
      const [paper, ink] = hues[(k - SIGN_HOARDINGS.from) % hues.length];
      g.fillStyle = paper;
      g.fillRect(x, y, CW, CH);
      g.fillStyle = ink;
      g.beginPath();
      g.arc(x + 34 + r() * 20, y + CH / 2, 20 + r() * 8, 0, Math.PI * 2);
      g.fill();
      g.fillRect(x + CW - 30, y, 30, CH);
      const text = (hk ? HK_SLOGANS : SLOGANS)[(k - SIGN_HOARDINGS.from) % SLOGANS.length];
      fit(g, text, '900', sans, CW - 120, 34);
      g.fillText(text, x + CW / 2 + 16, y + CH / 2 + 1);
      // The seams between the pasted sheets, and a corner torn away.
      g.fillStyle = 'rgba(40,36,30,0.25)';
      for (let s = 1; s < 4; s++) g.fillRect(x + (s * CW) / 4, y, 1, CH);
      g.fillStyle = '#6f6a5e';
      g.beginPath();
      g.moveTo(x + CW, y + CH);
      g.lineTo(x + CW - 30 - r() * 40, y + CH);
      g.lineTo(x + CW, y + CH - 14 - r() * 26);
      g.fill();
      distress(g, x, y, r, 1);
    }
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  return t;
}

/** The corner of cell `k` on the sheet and its size, in texture coordinates. */
export function signUV(k: number): [number, number, number, number] {
  const col = k % SIGN_COLS;
  const row = Math.floor(k / SIGN_COLS);
  // A hair inside the cell, so its neighbours never bleed in at a distance.
  const padU = 0.02 / SIGN_COLS;
  const padV = 0.06 / SIGN_ROWS;
  return [
    col / SIGN_COLS + padU,
    1 - (row + 1) / SIGN_ROWS + padV,
    1 / SIGN_COLS - 2 * padU,
    1 / SIGN_ROWS - 2 * padV,
  ];
}
