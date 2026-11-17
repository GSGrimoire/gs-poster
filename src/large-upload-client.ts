/** Shared browser upload transport for drafts and one-use chat pages.
 * Only videos over 50 MB use the bounded resumable R2 multipart protocol.
 */
export const LARGE_UPLOAD_JS = String.raw`
(() => {
  const SMALL_VIDEO = 50000000;
  async function send(url, method, body, headers) {
    const response = await fetch(url, {
      method, body, headers,
      credentials: "omit", redirect: "manual", referrerPolicy: "no-referrer",
    });
    const result = await response.json().catch(() => ({}));
    if(!response.ok || !result.ok)
      throw Error(result.error || "Private upload failed (HTTP " + response.status + ").");
    return result;
  }
  window.gsUploadFile = async (url, file, progress = () => {}) => {
    if(!url || !file || !Number.isSafeInteger(file.size) || file.size <= 0)
      throw Error("Select a nonempty file.");
    if(file.size <= SMALL_VIDEO || !/\.mp4$/i.test(file.name)) {
      progress(0, 1);
      const result = await send(url, "PUT", file);
      progress(1, 1);
      return result;
    }
    if(file.size > 300000000)throw Error("MP4 files must not exceed 300 MB.");
    const prefix = url + "/multipart/";
    const start = await send(prefix + "start", "POST", JSON.stringify({size:file.size}),
      {"Content-Type":"application/json"});
    const size = start.chunk_bytes, total = start.total_parts;
    if(!Number.isSafeInteger(size) || size < 5*1024*1024 ||
       !Number.isSafeInteger(total) || total !== Math.ceil(file.size / size))
      throw Error("Server returned invalid multipart settings.");
    try {
      for(let n=1;n<=total;n++){
        const left = (n-1)*size;
        const part = file.slice(left,Math.min(left+size,file.size),"video/mp4");
        const result=await send(prefix+"part/"+n,"PUT",part);
        if(result.part!==n || result.next_part!==n+1)
          throw Error("Video part confirmation did not match the expected order.");
        progress(n,total);
      }
      const finished=await send(prefix+"finish","POST");
      if(finished.bytes!==file.size || !finished.reference)
        throw Error("Final video size or reference was not confirmed.");
      return finished;
    }catch(error){
      // A server-side uncertain completion is intentionally not reopened.
      await send(prefix+"abort","POST").catch(()=>{});
      throw error;
    }
  };
})();
`;
