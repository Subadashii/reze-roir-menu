let data = [];
let activeCategory = "Todas";
const $ = (s) => document.querySelector(s);
const norm = (s) => (s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase();

async function init(){
  try{
    const res = await fetch("./commands.json");
    if(!res.ok) throw new Error("No se pudo leer commands.json");
    data = await res.json();
    const total = data.reduce((n,c)=>n+c.commands.length,0);
    renderCategories();
    render();
    document.title = "Reze Roir Bot · " + total + " comandos";
  }catch(e){
    $("#command-list").innerHTML = `<div class="empty">No se pudo cargar el catálogo. Abre la página mediante el servidor local indicado en README.md.</div>`;
  }
}
function renderCategories(){
  const nav=$("#category-nav");
  const names=["Todas",...data.map(c=>c.name)];
  nav.innerHTML=names.map(name=>`<button class="category-chip ${name===activeCategory?"active":""}" data-category="${escapeHtml(name)}">${name==="Todas"?"✧ ":""}${escapeHtml(name)}</button>`).join("");
  nav.querySelectorAll("button").forEach(btn=>btn.addEventListener("click",()=>{
    activeCategory=btn.dataset.category;
    renderCategories();render();
    document.querySelector(".results-head").scrollIntoView({behavior:"smooth",block:"start"});
  }));
}
function render(){
  const q=norm($("#search").value.trim());
  const selected=activeCategory==="Todas"?data:data.filter(c=>c.name===activeCategory);
  const groups=[];
  let total=0;
  selected.forEach(cat=>{
    const commands=cat.commands.filter(cmd=>!q||norm(cat.name+" "+cmd.syntax+" "+cmd.description).includes(q));
    if(commands.length){groups.push({name:cat.name,commands});total+=commands.length;}
  });
  $("#section-title").textContent=activeCategory==="Todas"?"Todos los comandos":activeCategory;
  $("#result-count").textContent=`${total} comando${total===1?"":"s"}`;
  const list=$("#command-list");
  if(!total){list.innerHTML='<div class="empty">No se encontraron comandos con esa búsqueda.</div>';return;}
  list.innerHTML=groups.map((group,gi)=>`
    <section class="category-block" style="animation-delay:${Math.min(gi*45,360)}ms">
      <header class="category-heading">
        <div class="category-emblem" aria-hidden="true">✧</div>
        <div class="category-heading-copy"><h3>${escapeHtml(group.name)}</h3><p>Comandos disponibles</p></div>
        <span class="category-count">${group.commands.length}</span>
      </header>
      <div class="command-list">${group.commands.map((item,i)=>`
        <article class="command-card" style="animation-delay:${Math.min(i*28,280)}ms">
          <span class="command-dot" aria-hidden="true"></span>
          <h4 class="syntax">${escapeHtml(item.syntax)}</h4>
          <button class="copy-btn" type="button" data-copy="${encodeURIComponent(item.syntax)}" aria-label="Copiar ${escapeHtml(item.syntax)}">COPIAR</button>
          <p class="description">${escapeHtml(item.description||"")}</p>
        </article>`).join("")}</div>
    </section>`).join("");
  list.querySelectorAll("[data-copy]").forEach(btn=>btn.addEventListener("click",async()=>{
    const value=decodeURIComponent(btn.dataset.copy);
    try{await navigator.clipboard.writeText(value);toast("Sintaxis copiada");}
    catch{toast("Tu navegador no permitió copiar");}
  }));
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
let toastTimer;
function toast(message){const el=$("#toast");el.textContent=message;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),1600);}
$("#search").addEventListener("input",render);
$("#clear").addEventListener("click",()=>{$("#search").value="";activeCategory="Todas";renderCategories();render();});
document.addEventListener("keydown",e=>{if(e.key==="/"&&document.activeElement!==$("#search")){e.preventDefault();$("#search").focus();}if(e.key==="Escape"){$("#search").value="";render();}});
init();
