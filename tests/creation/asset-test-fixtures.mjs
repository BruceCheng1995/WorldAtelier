import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {deflateSync} from 'node:zlib';

// A real compact RGBA PNG, generated as a file fixture rather than text payload.
export function assetFixturePNG(width=2){
 const chunk=(type,data)=>{
  const name=Buffer.from(type),body=Buffer.concat([name,data]);let crc=0xffffffff;
  for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  const length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([length,body,checksum]);
 };
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(2,4);header[8]=8;header[9]=6;
 const rows=Buffer.alloc((width*4+1)*2);
 for(let y=0;y<2;y++)for(let x=0;x<width;x++)rows.set([x%2?255:32,y?96:192,220,255],y*(width*4+1)+1+x*4);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}

export function assetFixtureGLB(root=process.cwd()){
 const directory=resolve(root,'content/model-preview'),manifest=JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8'));
 return readFileSync(resolve(directory,manifest.assets[0].file));
}
