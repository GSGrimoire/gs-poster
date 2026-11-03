/** Dependency audit report using npm's advisory database.
 *
 * Does not install, rewrite or update anything. A production high or critical
 * advisory makes the scheduled check fail; moderate/development findings are
 * reported but do not automatically establish deployed-worker reachability.
 */
import {spawnSync} from "node:child_process";
import {appendFileSync,writeFileSync} from "node:fs";

function runAudit(extra=[]){
  const proc=spawnSync("npm",["audit","--json",...extra],{
    encoding:"utf8",maxBuffer:16*1024*1024,timeout:120000,
    env:{...process.env,NO_COLOR:"1"},
  });
  if(proc.error)throw proc.error;
  let data;
  try {data=JSON.parse(proc.stdout);}
  catch {
    // A network failure is not proof of a clean dependency tree.
    throw new Error("npm audit did not return valid JSON (exit "+proc.status+").");
  }
  if(data.error)throw new Error("npm audit could not complete: "+String(data.error.code??"unknown"));
  if(!data.metadata?.vulnerabilities || typeof data.vulnerabilities!=="object")
    throw new Error("npm audit response was missing vulnerability metadata.");
  return {exitCode:proc.status,metadata:data.metadata.vulnerabilities,
    vulnerabilities:Object.entries(data.vulnerabilities).map(([name,info])=>{
      const v=info??{};
      return {name,severity:v.severity,direct:!!v.isDirect,range:v.range,
        via:(v.via??[]).filter(x=>typeof x==="object").map(x=>({
          title:x.title,url:x.url,severity:x.severity,range:x.range,
        })),
        fixAvailable:v.fixAvailable,
      };
    })};
}
function safe(s){return String(s??"").replaceAll("|","\\|").replace(/[\r\n]/g," ");}
function reportRow(v){
  const titles=v.via.map(x=>safe(x.title)).filter(Boolean);
  return "| "+safe(v.name)+" | "+safe(v.severity)+" | "+(v.direct?"Direct":"Transitive")+
    " | "+safe(titles.join("; ")||"Range inherited from dependency")+" |";
}
const full=runAudit();
const prod=runAudit(["--omit=dev"]);
const counts=x=>Object.entries(x.metadata).filter(([k])=>k!=="total")
  .map(([k,v])=>k+": "+v).join(", ");
const lines=[
  "## Dependency audit", "",
  "Baseline from the committed package-lock.json. This report does not establish whether a dependency is bundled into the production Worker.", "",
  "**All dependencies:** "+safe(counts(full))+"; **production dependency graph:** "+safe(counts(prod))+".", "",
  "### Production dependency graph", "",
  "| Package | Severity | Direct or transitive | Advisory |",
  "| --- | --- | --- | --- |",
  ...(prod.vulnerabilities.length?prod.vulnerabilities.map(reportRow):["| None reported | None | | |"]),
  "", "### Development-only or other full-tree findings", "",
  "| Package | Severity | Direct or transitive | Advisory |",
  "| --- | --- | --- | --- |",
  ...(full.vulnerabilities.filter(v=>!prod.vulnerabilities.some(p=>p.name===v.name)).length
    ?full.vulnerabilities.filter(v=>!prod.vulnerabilities.some(p=>p.name===v.name)).map(reportRow)
    :["| None reported | None | | |"]),
  "", "Review reachability, parent dependency chains and upstream fixes before updating anything.", "",
];
const output=lines.join("\n");
process.stdout.write(output+"\n");
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,output+"\n");
writeFileSync("audit-report.json",JSON.stringify({
  generated_at:new Date().toISOString(),full,production:prod,
},null,2));
const high=prod.vulnerabilities.filter(v=>["critical","high"].includes(v.severity));
if(high.length){
  process.stderr.write("Production dependency graph contains "+high.length+
    " high/critical advisory package(s); further reachability review required.\n");
  process.exitCode=1;
}
