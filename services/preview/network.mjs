import {hostname, networkInterfaces} from 'node:os';

export function workspaceNetwork(port, env=process.env) {
  // Alternate ports remain private unless an isolated test explicitly opts in.
  const lan=env.WORLD_ATELIER_LAN===undefined?port===48910:env.WORLD_ATELIER_LAN==='1';
  const publicPlay=env.WORLD_ATELIER_PUBLIC_PLAY===undefined?port===48910:env.WORLD_ATELIER_PUBLIC_PLAY==='1';
  const addresses=()=>Object.entries(networkInterfaces()).filter(([name])=>! /^(utun|tun|tap)/.test(name)).flatMap(([,rows])=>rows.filter(row=>!row.internal&&row.family==='IPv4').map(row=>row.address));
  const hosts=()=>new Set(['127.0.0.1','localhost','[::1]',...(lan?[hostname().toLowerCase(),...addresses()]:[])]);
  const requestOrigin=req=>{
    try {
      const authority=req.headers.host;
      if(typeof authority!=='string'||/[\s/@?#\\]/.test(authority))return null;
      const url=new URL(`http://${authority}`);
      if(Number(url.port||80)!==port||!hosts().has(url.hostname.toLowerCase()))return null;
      return url.origin;
    } catch {return null;}
  };
  return {lan,publicPlay,host:lan?'0.0.0.0':'127.0.0.1',requestOrigin,
    urls:()=>[...new Set(['127.0.0.1',...(lan?addresses():[])])].map(host=>`http://${host}:${port}/creation-workspace.html`)};
}
