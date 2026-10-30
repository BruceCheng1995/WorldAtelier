// Official Godot 4.6 OS_LinuxBSD::initialize() invokes xdg-user-dir once even
// for --headless/--version. When popen is denied it falls back to ".", inside
// the worker's private cwd. Preserve the raw log and exempt only that one
// exact startup diagnostic; later process attempts and game errors still fail.
export const LINUX_DESKTOP_PROBE_ERROR='ERROR: Cannot create pipe from command: "xdg-user-dir" "DESKTOP" 2>/dev/null.';
const errorPattern=/SCRIPT ERROR|Parse Error|ERROR:|Export failed|STANDALONE_FAILED|STANDALONE_RUNTIME_FAULT/;
const editorRidLeak=/^ERROR: \d+ RID allocations of type '([^'\r\n]*)' were leaked at exit\.$/;
const isEditorRidLeak=line=>{const match=editorRidLeak.exec(line);return Boolean(match&&!errorPattern.test(match[1]));};
export function godotErrorLines(output,{linux=process.platform==='linux',allowEditorRidLeaks=false}={}){
  let exempted=false;
  return String(output).split(/\r?\n/).filter(line=>{
    if(linux&&!exempted&&line===LINUX_DESKTOP_PROBE_ERROR){exempted=true;return false;}
    if(allowEditorRidLeaks&&isEditorRidLeak(line))return false;
    return errorPattern.test(line);
  });
}
export function createGodotErrorScanner({linux=process.platform==='linux',allowEditorRidLeaks=false}={}){
  const buffers=new Map();let exempted=false,failed=false;
  const inspect=line=>{
    if(linux&&!exempted&&line.replace(/\r$/,'')===LINUX_DESKTOP_PROBE_ERROR){exempted=true;return;}
    if(allowEditorRidLeaks&&isEditorRidLeak(line.replace(/\r$/,'')))return;
    if(errorPattern.test(line))failed=true;
  };
  return {
    push(value,stream='combined'){
      let pending=(buffers.get(stream)??'')+String(value),end;
      while((end=pending.indexOf('\n'))>=0){inspect(pending.slice(0,end));pending=pending.slice(end+1);}
      // Never lose an earlier error when the retained human-readable log is
      // truncated, and do not buffer unbounded author output without newlines.
      if(pending.length>65536){inspect(pending);pending=pending.slice(-256);}
      buffers.set(stream,pending);
    },
    finish(){for(const pending of buffers.values())inspect(pending);buffers.clear();return failed;},
    get hadError(){return failed;},
    get desktopProbeDenied(){return exempted;},
  };
}
