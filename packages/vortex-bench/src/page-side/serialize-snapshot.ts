// packages/vortex-bench/src/page-side/serialize-snapshot.ts
// page-side 脚本:序列化当前文档为自包含静态 HTML + 提议候选。
// 经 vortex_evaluate({code: SERIALIZE_SNAPSHOT_CODE}) 注入,返回 JSON.stringify(SerializeResult)。
// 保真度契约:烘焙 observe 关心的 computed 样式(cursor/visibility/display)为 inline style,
// 开放 shadow → DSD,srcdoc/同源 iframe 递归,剥 script。proposer 用比 observe 更宽的启发式。

export const SERIALIZE_SNAPSHOT_CODE = `(function(){
  var oracleSeq = 0;
  var candidates = [];
  var INTERACTIVE_ROLES = {button:1,link:1,textbox:1,checkbox:1,radio:1,tab:1,menuitem:1,treeitem:1,option:1,"switch":1,combobox:1,slider:1,menuitemcheckbox:1,menuitemradio:1};
  var NATIVE_TAGS = {BUTTON:1,A:1,INPUT:1,SELECT:1,TEXTAREA:1,SUMMARY:1};
  var VOID_TAGS = {area:1,base:1,br:1,col:1,embed:1,hr:1,img:1,input:1,link:1,meta:1,param:1,source:1,track:1,wbr:1};

  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }
  function escText(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  function isCandidate(el){
    if (NATIVE_TAGS[el.tagName]) return true;
    var role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES[role]) return true;
    var ti = el.getAttribute("tabindex");
    if (ti !== null && ti !== "-1") return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.tagName !== "HTML" && el.tagName !== "BODY") {
      try { if (getComputedStyle(el).cursor === "pointer") return true; } catch(e){}
    }
    return false;
  }
  function guessName(el){
    var al = el.getAttribute("aria-label"); if (al && al.trim()) return al.trim().slice(0,80);
    var t = el.getAttribute("title"); if (t && t.trim()) return t.trim().slice(0,80);
    var img = el.querySelector ? el.querySelector("img[alt]") : null;
    if (img && img.getAttribute("alt").trim()) return img.getAttribute("alt").trim().slice(0,80);
    var txt = (el.textContent||"").replace(/\\s+/g," ").trim();
    return txt ? txt.slice(0,80) : null;
  }
  function guessPattern(el){
    if (NATIVE_TAGS[el.tagName]) return "native";
    var role = el.getAttribute("role"); if (role) return "role-"+role;
    if (el.hasAttribute("onclick")) return "onclick";
    try { if (getComputedStyle(el).cursor === "pointer") return "cursor-pointer-div"; } catch(e){}
    if (el.getAttribute("tabindex")) return "tabindex";
    return "other";
  }
  function bakeStyle(el){
    var parts = [];
    try {
      var cs = getComputedStyle(el);
      if (cs.cursor && cs.cursor !== "auto" && cs.cursor !== "default") parts.push("cursor:"+cs.cursor);
      if (cs.visibility === "hidden") parts.push("visibility:hidden");
      if (cs.display === "none") parts.push("display:none");
    } catch(e){}
    return parts.join(";");
  }

  function serializeEl(el){
    var tag = el.tagName.toLowerCase();
    if (tag === "script") return "";
    var attrs = "";
    for (var i=0;i<el.attributes.length;i++){
      var a = el.attributes[i];
      if (a.name === "style") continue;
      if (a.name === "data-vtx-oracle") continue;
      attrs += " "+a.name+"=\\""+esc(a.value)+"\\"";
    }
    if (isCandidate(el)){
      var id = "c"+(oracleSeq++);
      attrs += " data-vtx-oracle=\\""+id+"\\"";
      var r = el.getBoundingClientRect();
      candidates.push({ id:id, role: el.getAttribute("role")||tag, name: guessName(el), pattern: guessPattern(el),
        bbox: [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)] });
    }
    var baked = bakeStyle(el);
    var existing = el.getAttribute("style");
    var style = [existing, baked].filter(Boolean).join(";");
    if (style) attrs += " style=\\""+esc(style)+"\\"";

    if (VOID_TAGS[tag]) return "<"+tag+attrs+">";

    if (tag === "iframe"){
      try {
        var doc = el.contentDocument;
        if (doc && doc.documentElement) {
          var frozen = serializeEl(doc.documentElement);
          return "<iframe"+attrs+" srcdoc=\\""+esc(frozen)+"\\"></iframe>";
        }
        return "<iframe"+attrs+"></iframe><!--iframe doc not accessible-->";
      } catch(e){ return "<iframe"+attrs+"></iframe><!--cross-origin iframe not captured-->"; }
    }

    var inner = "";
    if (el.shadowRoot){
      inner += "<template shadowrootmode=\\"open\\">";
      var sc = el.shadowRoot.childNodes;
      for (var j=0;j<sc.length;j++) inner += serializeNode(sc[j]);
      inner += "</template>";
    }
    var cn = el.childNodes;
    for (var k=0;k<cn.length;k++) inner += serializeNode(cn[k]);
    return "<"+tag+attrs+">"+inner+"</"+tag+">";
  }
  function serializeNode(node){
    if (node.nodeType === 3) return escText(node.nodeValue);
    if (node.nodeType === 1) return serializeEl(node);
    return "";
  }

  var html = "<!doctype html>\\n" + serializeEl(document.documentElement);
  // 返回对象(非 JSON.stringify):vortex_evaluate 会把返回值序列化一次。
  // 若这里再 stringify 会双重编码,bench 侧 JSON.parse 得到字符串而非对象。
  return { html: html, candidates: candidates };
})()`;
