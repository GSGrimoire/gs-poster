import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

test("browser and staging acceptance tools parse on the supported Node runtime",()=>{
  for(const name of ["pr90-browser-acceptance.mjs","pr90-staging-config.mjs",
    "pr90-staging-public-probe.mjs","pr90-staging-upload.mjs",
    "pr90-staging-private-video.mjs"]){
    const file=fileURLToPath(new URL("../scripts/"+name,import.meta.url));
    const result=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});
    assert.equal(result.status,0,name+": "+result.stderr);
  }
});
