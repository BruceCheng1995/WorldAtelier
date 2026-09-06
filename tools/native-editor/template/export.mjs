import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mergeNativeScene} from '../launcher/workspace.mjs';
try{console.log(JSON.stringify(await mergeNativeScene(resolve(dirname(fileURLToPath(import.meta.url)),'..'))));}
catch(error){console.error(error.message);process.exitCode=1;}
