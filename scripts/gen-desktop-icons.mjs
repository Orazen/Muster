import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = join(ROOT, "build");
const SIZE = 1024;
const SS = 4;
const STEPS = 128;

const STAR_STOPS = [
  { at: 0, color: [0xff, 0x9a, 0x73] },
  { at: 0.45, color: [0xf0, 0x46, 0x0e] },
  { at: 1, color: [0x8f, 0x2a, 0x08] },
];
const MARKER_COLOR = [0xf5, 0xf5, 0xf5];
const RALLY_ACCENT_STOPS = [
  { at: 0, color: [0xff, 0x7a, 0x45] },
  { at: 0.5, color: [0xf0, 0x46, 0x0e] },
  { at: 1, color: [0xc9, 0x3a, 0x0b] },
];
const CENTER = [512, 512];
const STAR_MAX_RADIUS = 330;
const starProfile = (t) => 0.62 + 0.38 * Math.pow(Math.abs(Math.cos(2.5 * t + Math.PI / 4)), 0.6);

function starPolygon(steps = STEPS) {
  const raw = Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    const r = starProfile(a);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  const maxR = Math.max(...raw.map((p) => Math.hypot(p.x, p.y)));
  return raw.map((p) => [CENTER[0]+(p.x/maxR)*STAR_MAX_RADIUS, CENTER[1]+(p.y/maxR)*STAR_MAX_RADIUS]);
}

const RALLY_RADIUS = 40;
const INNER_MARKER_RADIUS = 46;
const INNER_MARKERS = [[512,380],[644,512],[512,644],[380,512]];
const INNER_SPOKES = [[[512,426],[512,472]],[[598,512],[552,512]],[[512,598],[512,552]],[[426,512],[472,512]]];
const SPOKE_WIDTH = 8;

function circlePolygon([cx,cy], r, steps=64) {
  return Array.from({length:steps}, (_,i) => { const a=(i/steps)*Math.PI*2; return [cx+Math.cos(a)*r, cy+Math.sin(a)*r]; });
}
function strokeSegment([x0,y0],[x1,y1], width) {
  const half=width/2, dx=x1-x0, dy=y1-y0, len=Math.hypot(dx,dy)||1, nx=(-dy/len)*half, ny=(dx/len)*half;
  return [[[x0+nx,y0+ny],[x1+nx,y1+ny],[x1-nx,y1-ny],[x0-nx,y0-ny]], circlePolygon([x0,y0],half,24), circlePolygon([x1,y1],half,24)];
}
function rasterise(polygons, width) {
  const mask = new Uint8Array(width*width);
  for (const poly of polygons) {
    const ys=poly.map(p=>p[1]), top=Math.max(0,Math.floor(Math.min(...ys))), bottom=Math.min(width-1,Math.ceil(Math.max(...ys)));
    for (let y=top; y<=bottom; y++) {
      const sy=y+0.5, xs=[];
      for (let i=0; i<poly.length; i++) {
        const [x0,y0]=poly[i], [x1,y1]=poly[(i+1)%poly.length];
        if (y0===y1||sy<Math.min(y0,y1)||sy>=Math.max(y0,y1)) continue;
        xs.push(x0+((sy-y0)/(y1-y0))*(x1-x0));
      }
      xs.sort((a,b)=>a-b);
      for (let i=0; i+1<xs.length; i+=2) {
        const from=Math.max(0,Math.ceil(xs[i]-0.5)), to=Math.min(width-1,Math.floor(xs[i+1]-0.5));
        for (let x=from;x<=to;x++) mask[y*width+x]=1;
      }
    }
  }
  return mask;
}
const sample = (stops, t) => {
  const c=Math.min(1,Math.max(0,t));
  for (let i=0;i<stops.length-1;i++) { if (c<=stops[i+1].at) { const a=stops[i],b=stops[i+1],l=(c-a.at)/(b.at-a.at||1); return a.color.map((v,k)=>v+(b.color[k]-v)*l); } }
  return stops[stops.length-1].color;
};

const big=SIZE*SS, toBig=([x,y])=>[(x/1024)*big,(y/1024)*big];
const starMask=rasterise([starPolygon(STEPS).map(toBig)],big);
const rallyMask=rasterise([circlePolygon(CENTER,RALLY_RADIUS).map(toBig)],big);
const markerMask=rasterise(INNER_MARKERS.map(m=>circlePolygon(m,INNER_MARKER_RADIUS).map(toBig)),big);
const spokeMask=rasterise(INNER_SPOKES.flatMap(([a,b])=>strokeSegment(a,b,SPOKE_WIDTH).map(p=>p.map(toBig))),big);
const [scx,scy]=toBig(CENTER), sr=(STAR_MAX_RADIUS/1024)*big;
const gFrom=[scx-sr,scy-sr],gTo=[scx+sr,scy+sr],gV=[gTo[0]-gFrom[0],gTo[1]-gFrom[1]],gLSq=gV[0]**2+gV[1]**2;

const rgb=Buffer.alloc(SIZE*SIZE*3);
for (let y=0;y<SIZE;y++) { for (let x=0;x<SIZE;x++) {
  let acc=[0,0,0];
  for (let sy=0;sy<SS;sy++) { for (let sx=0;sx<SS;sx++) {
    const px=x*SS+sx,py=y*SS+sy,idx=py*big+px;
    let c;
    if (spokeMask[idx]||markerMask[idx]) c=MARKER_COLOR;
    else if (rallyMask[idx]) { const t=((px-gFrom[0])*gV[0]+(py-gFrom[1])*gV[1])/(gLSq||1); c=sample(RALLY_ACCENT_STOPS,t); }
    else if (starMask[idx]) { const t=((px-gFrom[0])*gV[0]+(py-gFrom[1])*gV[1])/(gLSq||1); c=sample(STAR_STOPS,t); }
    else c=[0x0a,0x0a,0x0a];
    acc=acc.map((v,i)=>v+c[i]);
  }}
  const at=(y*SIZE+x)*3, n=SS*SS;
  rgb[at]=Math.round(acc[0]/n); rgb[at+1]=Math.round(acc[1]/n); rgb[at+2]=Math.round(acc[2]/n);
}}

let CRC_TABLE=null;
function crc32(buf) { if(!CRC_TABLE){CRC_TABLE=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;CRC_TABLE[n]=c;}} let c=-1;for(const byte of buf)c=CRC_TABLE[(c^byte)&0xff]^(c>>>8);return c^-1; }
function encodePng(pixels, size) {
  const raw=Buffer.alloc((size*3+1)*size);
  for(let y=0;y<size;y++){raw[y*(size*3+1)]=0;pixels.copy(raw,y*(size*3+1)+1,y*size*3,(y+1)*size*3);}
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,"ascii"),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body)>>>0);return Buffer.concat([len,body,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(raw,{level:9})),chunk("IEND",Buffer.alloc(0))]);
}

writeFileSync(join(BUILD_DIR,"icon-1024.png"),encodePng(rgb,SIZE));
console.log("wrote build/icon-1024.png");

const ICONSET_DIR=join(BUILD_DIR,"icon.iconset");
mkdirSync(ICONSET_DIR,{recursive:true});
for (const s of [16,32,64,128,256,512]) {
  execSync(`sips -z ${s} ${s} ${join(BUILD_DIR,"icon-1024.png")} --out ${join(ICONSET_DIR,`icon_${s}x${s}.png`)} 2>/dev/null`);
  execSync(`sips -z ${s*2} ${s*2} ${join(BUILD_DIR,"icon-1024.png")} --out ${join(ICONSET_DIR,`icon_${s}x${s}@2x.png`)} 2>/dev/null`);
}
execSync(`iconutil -c icns "${ICONSET_DIR}" -o "${join(BUILD_DIR,"icon.icns")}"`);
console.log("wrote build/icon.icns");
