import sharp from "sharp";
const load = async (p) => sharp(p).greyscale().raw().toBuffer({ resolveWithObject: true });
const A = await load(process.argv[2]), B = await load(process.argv[3]);
const sizes=[11,12,13,14,16,18,20,24,28,32], weights=[400,500,600];
let y=0;
const bounds=(I,y0,y1)=>{let t=1e9,b=-1,l=1e9,r=-1,sum=0;const W=I.info.width;
 for(let yy=y0;yy<y1;yy++)for(let x=0;x<W;x++){const v=I.data[yy*W+x];sum+=v;if(v>96){t=Math.min(t,yy);b=Math.max(b,yy);l=Math.min(l,x);r=Math.max(r,x);}}
 // ink-weighted centroid y
 let cy=0,tot=0;for(let yy=y0;yy<y1;yy++)for(let x=0;x<W;x++){const v=I.data[yy*W+x];cy+=v*yy;tot+=v;}
 return {t:t-y0,b:b-y0,l,r,ink:sum,cy:(cy/tot-y0)};};
for(const s of sizes)for(const w of weights){const h=Math.ceil(s*1.45)+6;
 const a=bounds(A,y,y+h), c=bounds(B,y,y+h);
 console.log(`${s}/${w}: top ${a.t}->${c.t} bot ${a.b}->${c.b} cy ${a.cy.toFixed(2)}->${c.cy.toFixed(2)} (d ${(c.cy-a.cy).toFixed(2)}) right ${a.r}->${c.r} ink ${(c.ink/a.ink).toFixed(3)}`);
 y+=h;}
