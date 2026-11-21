/**
 * @fileoverview Swarm pane Overview and Members views.
 *
 * Renders the narrator's goal, threads, running tasks and progress (Overview)
 * and the member list (Members) from the /api/swarm snapshot app.js already
 * polls. Members are drawn as pixel bees. app.js calls
 * window.SwarmHive.update(snapshot, element, {view: 'overview' | 'cards'}).
 * Every string from the board or the narrator goes through esc().
 */
(function() {
  let S = {}, P = [];
  const state = {view: 'overview'};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const people = sc => Object.entries(sc.members).filter(([n, x]) => !x.system);
  const ORDER = {needs_you: 0, working: 1, waiting_on: 2, parked: 3};

  const CJK_CHAR_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
  const CJK_MENTION_MASK_RE = /(^|[^\p{L}\p{N}_-]|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])(@(?:all|#[a-z][a-z0-9-]{0,23}|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}_-])+))/gu;
  const CJK_CITE_MASK_RE = /(^|[^\p{L}\p{N}_&#/-]|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])(#[1-9]\d{0,8})(?!(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}_-])/gu;

  function findFenceOpener(line) {
    if (!line.includes('```')) return null;
    let i = 0;
    while (i < line.length) {
      if (line[i] !== '`') {
        const next = line.indexOf('`', i);
        if (next === -1) return null;
        i = next;
      }
      let n = 0;
      while (i + n < line.length && line[i + n] === '`') n++;
      let j = i + n;
      let closeStart = -1;
      while (j < line.length) {
        if (line[j] !== '`') {
          const next = line.indexOf('`', j);
          if (next === -1) break;
          j = next;
        }
        let m = 0;
        while (j + m < line.length && line[j + m] === '`') m++;
        if (m === n) {
          closeStart = j;
          break;
        }
        j += m;
      }
      if (closeStart !== -1 && closeStart > i + n) {
        i = closeStart + n;
        continue;
      }
      if (n >= 3) {
        const prefix = line.slice(0, i);
        const info = line.slice(i + n);
        if ((prefix === '' || /\s$/.test(prefix)) && !info.includes('`')) {
          return { prefix, ticks: n, fence: line.slice(i) };
        }
      }
      i += n;
    }
    return null;
  }

  function maskFencedBlocks(text, hold) {
    const lines = text.split('\n');
    const out = [];
    const stack = [];
    let buf = [];
    let openPrefix = '';
    for (const line of lines) {
      if (!stack.length) {
        const opener = findFenceOpener(line);
        if (opener) {
          openPrefix = opener.prefix;
          stack.push(opener.ticks);
          buf = [opener.fence];
          continue;
        }
        out.push(line);
        continue;
      }
      const m = /^[ \t]*(`{3,})(.*)$/.exec(line);
      if (m) {
        const ticks = m[1].length;
        const info = m[2];
        const infoTrim = info.trim();
        const top = stack[stack.length - 1];
        if (!infoTrim && ticks >= top) {
          buf.push(line);
          stack.pop();
          if (!stack.length) {
            out.push(openPrefix + hold(buf.join('\n')));
            buf = [];
            openPrefix = '';
          }
          continue;
        }
        if (infoTrim && !info.includes('`') && ticks >= top) {
          stack.push(ticks);
          buf.push(line);
          continue;
        }
      }
      buf.push(line);
    }
    if (stack.length && buf.length) {
      out.push(openPrefix + hold(buf.join('\n')));
    }
    return out.join('\n');
  }

  function maskInlineCode(text, hold) {
    if (!text.includes('`')) return text;
    return text.split('\n').map((line) => {
      if (!line.includes('`')) return line;
      let out = '';
      let i = 0;
      while (i < line.length) {
        if (line[i] !== '`') {
          const next = line.indexOf('`', i);
          if (next === -1) { out += line.slice(i); break; }
          out += line.slice(i, next);
          i = next;
        }
        let n = 0;
        while (i + n < line.length && line[i + n] === '`') n++;
        let j = i + n;
        let closeStart = -1;
        while (j < line.length) {
          if (line[j] !== '`') {
            const next = line.indexOf('`', j);
            if (next === -1) break;
            j = next;
          }
          let m = 0;
          while (j + m < line.length && line[j + m] === '`') m++;
          if (m === n) {
            closeStart = j;
            break;
          }
          j += m;
        }
        if (closeStart !== -1 && closeStart > i + n) {
          out += hold(line.slice(i, closeStart + n));
          i = closeStart + n;
        } else {
          out += line.slice(i, i + n);
          i += n;
        }
      }
      return out;
    }).join('\n');
  }

  const URL_PROTO_RE = /(?:https?|file):\/\//gi;
  const URL_SAFE_CHAR_RE = /^[^\s<>"'`*()（）[\]【】，。；：、！？\u27E6\u27E7]$/;
  function maskBalancedUrls(text, onUrl) {
    URL_PROTO_RE.lastIndex = 0;
    let m = URL_PROTO_RE.exec(text);
    if (!m) return text;
    let matchClose = null;
    if (text.includes('(')) {
      matchClose = new Int32Array(text.length);
      matchClose.fill(-1);
      const stack = [];
      for (let k = 0; k < text.length; k++) {
        const ch = text[k];
        if (ch === '(') stack.push(k);
        else if (ch === ')') {
          if (stack.length) matchClose[stack.pop()] = k;
        } else if (!URL_SAFE_CHAR_RE.test(ch)) {
          stack.length = 0;
        }
      }
    }
    let out = '';
    let cursor = 0;
    while (m) {
      const start = m.index;
      if (start < cursor) {
        m = URL_PROTO_RE.exec(text);
        continue;
      }
      if (start > 0 && /[A-Za-z0-9]/.test(text[start - 1])) {
        m = URL_PROTO_RE.exec(text);
        continue;
      }
      const afterProto = start + m[0].length;
      if (afterProto >= text.length || !URL_SAFE_CHAR_RE.test(text[afterProto])) {
        m = URL_PROTO_RE.exec(text);
        continue;
      }
      let i = afterProto + 1;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '(') {
          const closeIdx = matchClose ? matchClose[i] : -1;
          if (closeIdx === -1) break;
          i = closeIdx + 1;
        } else if (URL_SAFE_CHAR_RE.test(ch)) {
          i++;
        } else {
          break;
        }
      }
      const rawUrl = text.slice(start, i);
      const trailMatch = /[.,;:!?]+$/.exec(rawUrl);
      const clean = trailMatch ? rawUrl.slice(0, trailMatch.index) : rawUrl;
      const trail = trailMatch ? trailMatch[0] : '';
      if (clean.length > m[0].length) {
        out += text.slice(cursor, start) + onUrl(clean) + trail;
        cursor = i;
        URL_PROTO_RE.lastIndex = i;
      }
      m = URL_PROTO_RE.exec(text);
    }
    return cursor === 0 ? text : out + text.slice(cursor);
  }

  function tier1ClientFallback(input) {
    if (input == null) return '';
    let s = String(input);
    if (!s.trim()) return s;

    // 1. Mask technical literals so protocol/prose rules never corrupt code, paths, @mentions, #seq, URLs.
    const tokens = [];
    const hold = (m) => { const idx = tokens.length; tokens.push(m); return `\u27E6P${idx}\u27E7`; };
    s = maskBalancedUrls(maskInlineCode(maskFencedBlocks(s, hold), hold), hold)
         .replace(/(?:[A-Za-z]:\\[^\s"'`<>|()（）\[\]【】，。；：、,!！?？]+|\/(?:[\w.-]+\/)+[\w.-]*)/g, hold)
         .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, hold)
         .replace(CJK_MENTION_MASK_RE, (_, pre, tok) => pre + hold(tok))
         .replace(CJK_CITE_MASK_RE, (_, pre, tok) => pre + hold(tok));

    // 2. Protocol tags (run even if the rest of the message is already Chinese).
    s = s.replace(/\[done\]/gi, '[已完成]')
         .replace(/\[stall\]/gi, '[停滞告警]')
         .replace(/\[quota\]/gi, '[额度告警]')
         .replace(/\[blocked\]/gi, '[阻塞]')
         .replace(/\[channel\]/gi, '[频道]')
         .replace(/^(resume)(?=[\s:：]|$)/gim, '恢复运行');

    // Skip prose rules if already predominantly Chinese (CJK >= 40% of letters/CJK).
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    const skipProse = cjk > 0 && cjk / (cjk + latin) >= 0.4;

    if (!skipProse) {
      const EXACT = {
        'Waiting for posts': '等待看板消息',
        'Reading the board': '正在读取看板',
        'Posting to the board': '正在发送到看板',
        'No posts yet': '暂无消息',
        'Waiting for the first post.': '等待首条消息。',
        'Waiting for the first post': '等待首条消息',
        'Untitled swarm': '未命名 Swarm',
        'Coordinator': '协调者',
        'Done': '已完成',
        'In progress': '进行中',
        'In review': '审阅中',
        'model error': '模型错误',
        'step failed': '步骤执行失败',
        'The coordinator is waiting for your reply': '协调者正在等待你的回复',
        'Answer it in the coordinator chat.': '请在协调者对话中回复。',
        'Waiting for your reply in chat': '正在对话中等待你的回复',
      };
      const trimmed = s.trim();
      if (Object.hasOwn(EXACT, trimmed)) {
        s = EXACT[trimmed];
      } else {
        const VERB_MAP = { spawn: '创建', kill: '停止', wait: '等待', status: '状态', post: '发帖', read: '读取' };
        const HEAD_MAP = { summary: '摘要', conclusion: '结论', verification: '验证', status: '状态', next: '下一步', 'next step': '下一步', 'next steps': '下一步', blocker: '阻塞项', blockers: '阻塞项', action: '操作' };
        s = s
          .replace(/^([^:\n]+):\s*last step failed \((quota|error)\)$/i,
            (_, m, k) => `${m}: 上一步执行失败（${k.toLowerCase() === 'quota' ? '额度耗尽' : '错误'}）`)
          .replace(/^last step failed \((quota|error)\)$/i,
            (_, k) => `上一步执行失败（${k.toLowerCase() === 'quota' ? '额度耗尽' : '错误'}）`)
          .replace(/^([^:\n]+):\s*no progress,\s*and not waiting on the board$/i,
            (_, m) => `${m}: 暂无进展，且未在看板等待`)
          .replace(/^no progress,\s*and not waiting on the board$/i,
            '暂无进展，且未在看板等待')
          .replace(/^Read\s+(.+)$/i, '读取 $1')
          .replace(/^Write\s+(.+)$/i, '写入 $1')
          .replace(/^Edit\s+(.+)$/i, '编辑 $1')
          .replace(/^Search\s+(.+)$/i, '搜索 $1')
          .replace(/^Run(?:ning)?\s+(.+)$/i, '运行 $1')
          .replace(/^swarm\s+(spawn|kill|wait|status|post|read)\b(.*)$/i,
            (_, act, rest) => `Swarm ${VERB_MAP[act.toLowerCase()] || act}${rest}`)
          .replace(/\bcreated\s+(#\S+)/gi, '创建了频道 $1')
          .replace(/\barchived\s+(#\S+)/gi, '归档了频道 $1')
          .replace(/\bsubscribed\s+(\S+)\s+to\s+(#\S+)/gi, '已将 $1 订阅到 $2')
          .replace(/\bunsubscribed\s+(\S+)\s+from\s+(#\S+)/gi, '已将 $1 从 $2 取消订阅')
          .replace(/^(Summary|Conclusion|Verification|Status|Next steps?|Blockers?|Action)\s*:/gim,
            (_, h) => `${HEAD_MAP[h.toLowerCase()] || h}：`)
          .replace(/\ball tests pass(?:ed|ing)?\b/gi, '所有测试通过')
          .replace(/\bready for review\b/gi, '已就绪待审阅')
          .replace(/\bwaiting (?:for|on)\b/gi, '等待')
          .replace(/\bblocked by\b/gi, '阻塞于')
          .replace(/\bno blockers\b/gi, '无阻塞');
      }
    }

    // 4. Restore protected technical literals.
    return s.replace(/\u27E6P(\d+)\u27E7/g, (_, i) => tokens[Number(i)] ?? '');
  }

  /* ---------- pixel bees ---------- */
  const HUE = Object.assign(Object.create(null), {coordinator:46});
  function hsl2hex(h,s,l){ h=((h%360)+360)%360; s/=100; l/=100; const k=n=>(n+h/30)%12; const a=s*Math.min(l,1-l); const f=n=>l-a*Math.max(-1,Math.min(k(n)-3,Math.min(9-k(n),1))); return '#'+[f(0),f(8),f(4)].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join(''); }
  const shiftHue=(h,target,amt)=>{ const d=((target-h+540)%360)-180; return h+d*amt; };
  function ramp(n){ const h=hueOf(n); return {
    spec: hsl2hex(shiftHue(h,55,0.28), 96, 90), hi: hsl2hex(shiftHue(h,55,0.18), 90, 74), mid: hsl2hex(h, 78, 60),
    sh: hsl2hex(shiftHue(h,265,0.22), 58, 44), ol: hsl2hex(shiftHue(h,265,0.35), 42, 19),
    skh: hsl2hex(shiftHue(h,265,0.15), 20, 30), sk: hsl2hex(shiftHue(h,265,0.3), 24, 18), skd: hsl2hex(shiftHue(h,265,0.45), 32, 10) }; }
  const tcol = n => hsl2hex(hueOf(n), 78, 60);
  const hueOf = n => (Object.hasOwn(HUE, n) ? HUE[n] : [12,150,262,330,196,228,96,28,290,175,350,60][hash(String(n))%12]);
  const hash = s => [...s].reduce((a,c)=>(a*31+c.charCodeAt(0))>>>0, 7);
  const HEXD = (s => encodeURIComponent(s).replace(/'/g, '%27'))(`<svg xmlns='http://www.w3.org/2000/svg' width='28' height='24.25' viewBox='0 0 28 24.25'><path d='M14 0l12.12 7v14l-12.12 7L1.88 21V7z' fill='none' stroke='rgba(255,255,255,0.08)' stroke-width='1.2'/></svg>`);
  // Tiles tint the host card color so they work in light and dark themes.
  const tileTint = n => `color-mix(in srgb, ${tcol(n)} 22%, var(--sw-card, #fff))`;
  const hexBG = n => n==='coordinator' ? `background:#1C1B22 url('data:image/svg+xml,${HEXD}')` : `background:${tileTint(n)}`;

  function drawBee(cv, name, state, frame){
    const W=22,H=18; cv.width=W; cv.height=H; const c=cv.getContext('2d'); c.imageSmoothingEnabled=false; c.clearRect(0,0,W,H);
    const R=ramp(name), queen=name==='coordinator', landed=(state==='parked'||state==='landed'), asleep=state==='parked';
    const P=(x,y,col)=>{ if(x<0||y<0||x>=W||y>=H) return; c.fillStyle=col; c.fillRect(x,y,1,1); };
    const cx=11, cy=10.5, rx=7.3, ry=4.8;
    const inside=(x,y)=>{ const nx=(x+0.5-cx)/rx, ny=(y+0.5-cy)/ry; return nx*nx+ny*ny<=1; };
    let L=[-0.42,-0.62,0.66]; const Ln=Math.hypot(...L); L=L.map(v=>v/Ln);
    const N4=[[1,0],[-1,0],[0,1],[0,-1]];
    const rows=(spec)=>{ const pts=[]; spec.forEach(([y,x0,x1])=>{ for(let x=x0;x<=x1;x++) pts.push([x,y]); }); return pts; };
    const drawWing=(pts, glint)=>{ const set=new Set(pts.map(p=>p.join(','))); pts.forEach(([x,y])=>{ const edge=N4.some(([dx,dy])=>!set.has((x+dx)+','+(y+dy))); P(x,y, edge?'rgba(140,160,192,0.9)':'rgba(255,255,255,0.72)'); });
      if(glint){ const tl=pts.filter(([x,y])=>!N4.some(([dx,dy])=>!set.has((x+dx)+','+(y+dy)))).sort((a,b)=>(a[1]-b[1])||(a[0]-b[0])); if(tl[0]) P(tl[0][0],tl[0][1],'#FFFFFF'); } };
    let back=null, front;
    if(landed){ front=rows([[5,14,17],[6,13,18]]); }
    else if(frame===0){ back=rows([[1,16,17],[2,16,18],[3,15,18],[4,15,17],[5,15,16]]); front=rows([[0,13,14],[1,12,15],[2,11,15],[3,11,14],[4,11,13],[5,11,12]]); }
    else { back=rows([[3,16,18],[4,15,19],[5,16,18]]); front=rows([[3,13,16],[4,12,17],[5,12,17],[6,13,15]]); }
    if(back) drawWing(back,false);
    const stripe=(x,y)=>{ const ny=(y+0.5-cy)/ry; const u=x+0.5+1.15*ny*ny; return (u>10.6&&u<12.5)||(u>14.3&&u<16.1)||(u>17.9); };
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){
      if(!inside(x,y)) continue;
      const nx=(x+0.5-cx)/rx, ny=(y+0.5-cy)/ry, rr=Math.min(1,nx*nx+ny*ny), nz=Math.sqrt(1-rr);
      const I=nx*L[0]+ny*L[1]+nz*L[2];
      P(x,y, stripe(x,y) ? (I>0.80?R.skh : I>0.30?R.sk : R.skd) : (I>0.965?R.spec : I>0.78?R.hi : I>0.26?R.mid : R.sh));
    }
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){
      if(inside(x,y)) continue;
      const nbs=N4.filter(([dx,dy])=>inside(x+dx,y+dy)); if(!nbs.length) continue;
      const nx=(x+0.5-cx)/rx, ny=(y+0.5-cy)/ry, n=Math.hypot(nx,ny); const d=(nx/n)*L[0]+(ny/n)*L[1];
      const nextToStripe=nbs.some(([dx,dy])=>stripe(x+dx,y+dy));
      P(x,y, (d>0.5 && !nextToStripe) ? R.sh : R.ol);
    }
    // stinger
    P(19,10,R.ol); P(20,10,R.ol);
    // face
    if(asleep){ P(6,10,R.ol); P(7,10,R.ol); }
    else { P(6,9,'#FFFFFF'); P(7,9,R.skd); P(6,10,R.skd); P(7,10,R.skd); }
    P(5,11,'rgba(255,128,150,0.55)'); P(4,11,'rgba(255,128,150,0.35)');
    // antennae or crown
    if(queen){ const g1='#F7CE5B', g2='#FFE9A6', g3='#C98A2B'; [[5,5],[6,5],[7,5],[8,5],[9,5]].forEach(([x,y])=>P(x,y,g1)); P(5,4,g2); P(7,4,g2); P(9,4,g2); P(7,3,g2); P(5,5,g3); P(9,5,g3); P(7,5,'#E4566A'); }
    else { [[7,5],[6,4],[5,3]].forEach(([x,y])=>P(x,y,R.ol)); P(4,3,R.sk); [[9,5],[9,4],[9,3]].forEach(([x,y])=>P(x,y,R.ol)); P(8,2,R.sk); }
    drawWing(front,true);
    if(asleep){ const z='#8C90A6'; [[0,0],[1,0],[2,0],[3,0],[2,1],[1,2],[0,3],[1,3],[2,3],[3,3]].forEach(([x,y])=>P(x,y,z)); }
  }
  const spriteTag = (n, state) => `<span class="beebox" data-state="${esc(state||'working')}"><span class="beewrap" data-bee="${esc(n)}" data-state="${esc(state||'working')}"><canvas></canvas><canvas></canvas></span><i class="gsh"></i></span>`;
  function paintSprites(el){ el.querySelectorAll('.beewrap').forEach(w=>{ const [a,b]=w.querySelectorAll('canvas'); drawBee(a, w.dataset.bee, w.dataset.state, 0); drawBee(b, w.dataset.bee, w.dataset.state, 1); }); }

  // Board avatars: one still (landed) bee per name, drawn once and reused as an <img>.
  const beeImgs = new Map();
  function beeImg(n){
    if(!beeImgs.has(n)){ const cv=document.createElement('canvas'); drawBee(cv, n, 'landed', 0); beeImgs.set(n, cv.toDataURL()); }
    return beeImgs.get(n);
  }

  // Nudge each bee onto the device pixel grid so the sprites stay crisp. Reads
  // all positions first (without the previous nudge), then writes.
  function snapBees(root){
    const dpr=window.devicePixelRatio||1;
    const boxes=[...root.querySelectorAll('.beebox')];
    const rects=boxes.map(b=>{ const r=b.getBoundingClientRect(); const m=/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(b.style.transform||''); return {x:r.left-(m?+m[1]:0), y:r.top-(m?+m[2]:0)}; });
    boxes.forEach((b,i)=>{ const fx=(rects[i].x*dpr)%1, fy=(rects[i].y*dpr)%1; const dx=(fx>0.5?1-fx:-fx)/dpr, dy=(fy>0.5?1-fy:-fy)/dpr;
      b.style.transform = (Math.abs(dx)>0.01||Math.abs(dy)>0.01) ? `translate(${dx}px,${dy}px)` : ''; });
  }
  let snapQueued=false;
  const snapAll=()=>{ if(snapQueued) return; snapQueued=true; requestAnimationFrame(()=>{ snapQueued=false; document.querySelectorAll('.pane').forEach(snapBees); }); };
  window.addEventListener('scroll', snapAll, {passive:true, capture:true});
  window.addEventListener('resize', snapAll);

  const COPY_UI = { team:'团队', lead:'协调者', blocked:'阻塞', running:'进行中', planned:'待安排', done:'已完成',
    more:'还有 {n} 项', goal:'目标', threads:'任务线', now:'当前', progress:'进展', compare:'对比前后画面', hide_compare:'隐藏对比', expand:'打开完整时间线', none_blocked:'暂无阻塞', needs:'需要你', waiting:'等待 @coordinator', stuck:'受阻', none_waiting:'暂无等待', none_stuck:'暂无受阻', none_needs:'暂无需要你处理', none_running:'暂无进行中', none_planned:'暂无待安排' };
  // Workers never ask the user: their decisions, reviews and quota wait on the
  // coordinator, and their failures show on the worker as Stuck or Error. Only
  // the coordinator stopping for the user (a reply in chat, quota, a failure)
  // needs the user. toModel sets each attention item's `wait` to
  // 'you' | 'coordinator' | 'issue'.
  const ISSUE_KINDS = new Set(['failure','stuck','error']);
  const waitOn = n => `等待 @${n}`;
  // Short copy the narrator writes next to each item (view.json `short` and `now`).
  function copy(){ const a=(window.SwarmHive||{}).viewCopy||{};
    return { ui:a.ui||{}, lead:a.lead||{}, members:a.members||{}, items:a.items||{} }; }
  function ui(k){ const c=copy().ui||{}; return (Object.hasOwn(c, k) && c[k]) || COPY_UI[k]; }
  function clipWords(s, n){
    s=String(s||'').replace(/\s*\([^)]*\)/g,'').replace(/\s+/g,' ').trim();
    if(CJK_CHAR_RE.test(s)){
      const maxChars = Math.max(8, n * 4);
      return s.length > maxChars ? s.slice(0, maxChars - 1).replace(/[，。；：、,;:.！？!]+$/,'')+'…' : s.replace(/[。！？；.!:]+$/,'');
    }
    const w=s.split(' ');
    return w.length>n ? w.slice(0,n).join(' ').replace(/[,;:.]$/,'')+'…' : s.replace(/\.$/,'');
  }
  function firstClause(s){ return String(s||'').split(/(?<=[.!?。！？])\s+(?=[A-Z])|(?<=[。！？；])\s*|;\s|\s[–—-]\s/)[0]; }
  function itemCopy(id, title, line, shortOverride){ const items=copy().items||{}; const c=shortOverride!==undefined ? (shortOverride||{}) : ((Object.hasOwn(items, id) && items[id]) || {}); return { title: c.title || clipWords(title, 7), line: c.line || clipWords(firstClause(line), 12) }; }
  // A working member's latest step (newest tool call or thinking heading in its
  // transcript), drawn with the in-progress shimmer. Views re-render on every
  // poll, so the shimmer is phased off the wall clock to keep sweeping.
  const SHIMMER_MS = 1900;   // .animate-shimmer-text cycle (styles.css --shimmer-ms)
  const liveText = (live, text) =>
    `<span class="animate-shimmer-text" style="animation-delay:-${Date.now() % SHIMMER_MS}ms">${esc(text ?? live.text)}</span>`;
  const liveTip = live => `${live.kind==='thinking' ? '思考中' : '最新操作'}: ${live.text}`;
  // Live activity beats the narrator's copy, which lags the board.
  function memberLine(n, x){ if(x && x.live) return clipWords(firstClause(x.live.text), 8); const c=copy().members||{}; if(Object.hasOwn(c, n) && c[n]) return c[n]; if(n==='coordinator'){ const l=(copy().lead||{}).doing; if(l) return l; } return clipWords(firstClause(x.now||''), 6); }
  function cleanNote(s, fallback){
    let x = String(s||'').replace(/\s*\(#\d+(?:\s*,\s*#\d+)*\)\s*\.?$/,'').replace(/\s+/g,' ').trim();
    if(x) x = x.charAt(0).toUpperCase() + x.slice(1);
    return x || String(fallback||'').trim();
  }

  /* ---------- Shared bee badges, compact ring, Running card, and Done disclosure ---------- */
  function workerBadges(owners, max, sc){
    const lim = max || 2;
    const list = (owners||[]).slice(0, lim);
    const extra = Math.max(0, (owners||[]).length - list.length);
    return `<span class="o2-wchips">${list.map(n=>{
      const m = sc && sc.members && Object.hasOwn(sc.members, n) ? sc.members[n] : null;
      const st = (sc && !sc.finished && m && !m.killed && m.status==='working') ? 'working' : 'landed';
      return `<span class="o2-wchip bee" title="@${esc(n)}">${spriteTag(n, st)}<span>${esc(n)}</span></span>`;
    }).join('')}${extra>0?`<span class="o2-wchip more">+${extra}</span>`:''}</span>`;
  }

  function taskProgressPill(w){
    if(w && w.progress && w.progress.total>0){
      const pct = Math.min(100, Math.max(0, Math.round((w.progress.done / w.progress.total) * 100)));
      const lbl = w.progress.label || `${w.progress.done}/${w.progress.total}`;
      return `<span class="o2-tprog" title="${esc(lbl)} 已完成"><span class="o2-tpbar"><i style="width:${pct}%"></i></span><span>${esc(lbl)}</span></span>`;
    }
    if(w && w.rawState==='review') return `<span class="o2-tprog rev">审阅中</span>`;
    return '';
  }

  function ringSvg(tot){
    const sum = tot.done + tot.running + tot.blocked + tot.queued;
    if(sum > 0 && tot.done === sum){
      return `<span class="o2-ring full" aria-hidden="true">✓</span>`;
    }
    const total = sum || 1;
    const C = 43.98;
    let off = 0;
    const segs = ['done','running','blocked'].map(k=>{
      if(!tot[k]) return '';
      const len = (tot[k] / total) * C;
      const s = `<circle cx="9" cy="9" r="7" fill="none" class="seg ${k}" stroke-width="2.2" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`;
      off += len;
      return s;
    }).join('');
    return `<svg class="o2-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" class="trk" stroke-width="2.2"/>${segs}</svg>`;
  }

  function miniBar(n){
    const sum = n.done + n.running + n.blocked + n.queued || 1;
    return `<span class="o2-mbar" aria-hidden="true">${['done','running','blocked','queued'].map(k=>n[k]?`<i class="${k}" style="flex:${n[k]}"></i>`:'').join('')}</span>`;
  }

  function runningCard(sc, runningWs, summaryText, goalTitle, goalLine){
    if(!runningWs.length || sc.finished) return '';
    let sum = sc.runningSummary || '';
    if(!sum && sc.headline && sc.headline !== goalTitle && sc.headline !== goalLine) sum = sc.headline;
    if(!sum && !sc.fromPlan) sum = summaryText || '';
    const lim = state.o2runAll ? runningWs.length : 8;
    const vis = runningWs.slice(0, lim);
    const more = runningWs.length - vis.length;
    const ph = sc.phase && sc.phase.total > 1 ? `<span class="o2-runph">${esc(sc.phase.label)} · ${sc.phase.index}/${sc.phase.total}</span>` : '';
    const rows = vis.map(({w, st})=>{
      const c = itemCopy(w.id, w.title, w.note, w.short ?? null);
      const note = cleanNote(w.note, c.line);
      // An owner at work shows its live step; the narrator's note stays in the tooltip.
      const lm = st==='running' ? (w.owners||[]).map(n=>sc.members && Object.hasOwn(sc.members, n) ? sc.members[n] : null).find(m=>m && !m.killed && m.live) : null;
      // Without a narrator view the note is the live step itself: don't repeat it.
      const extra = lm && note && note.toLowerCase() !== lm.live.text.toLowerCase() ? `\n${note}` : '';
      const noteHtml = lm
        ? `<p class="o2-runnote o2-live" data-testid="swarm-running-activity" title="${esc(liveTip(lm.live) + extra)}">${liveText(lm.live)}</p>`
        : (note ? `<p class="o2-runnote" title="${esc(w.note||note)}">${esc(note)}</p>` : '');
      return `<li class="o2-runrow ${st}">
        <span class="o2-ti ${st}" aria-label="${st === 'blocked' ? '阻塞' : '进行中'}"></span>
        <div class="o2-runmain">
          <div class="o2-runtop">
            <b class="o2-runt">${esc(c.title)}</b>
            ${taskProgressPill(w)}
            ${workerBadges(w.owners, 2, sc)}
          </div>
          ${noteHtml}
        </div>
      </li>`;
    }).join('');
    return `<section class="o2-run">
      <div class="o2-runh"><span class="o2-rundot" aria-hidden="true"></span><b>${ui('running')}</b><em>${runningWs.length}</em>${ph}</div>
      ${sum ? `<p class="o2-runsum">${esc(sum)}</p>` : ''}
      <ul class="o2-runlist">${rows}</ul>
      ${more>0 ? `<button class="o2-more" data-o2="runAll">${ui('more').replace('{n}', more)}</button>` : ''}
    </section>`;
  }

  // Chips that say who the swarm is waiting on: "2 waiting on @coordinator",
  // "1 stuck". `waits` maps member -> count.
  function waitChips(waits, stuck){
    const out = [...waits.entries()].sort((a,b)=>b[1]-a[1]).slice(0,2)
      .map(([n,c])=>`<span class="o2-pchip warn"><i></i>${c} ${esc(waitOn(n))}</span>`);
    if(stuck > 0) out.push(`<span class="o2-pchip bad"><i></i>${stuck} 项受阻</span>`);
    return out;
  }
  const TSTATE = { done:'done', active:'running', review:'running', blocked:'blocked', failed:'blocked', queued:'queued' };
  const stOfWs = (sc, w) => { if(w.state!=='done' && w.state!=='blocked'){ const o=w.owners[0]; const m=sc.members && Object.hasOwn(sc.members, o) ? sc.members[o] : null; if(m && m.status==='waiting_on') return 'blocked'; } return TSTATE[w.state]||'queued'; };

  function progressCard(sc, tot, doneWs, queuedWs, openThreads, openAsks, extraChips){
    const totalCount = tot.done + tot.running + tot.blocked + tot.queued;
    const open = !!state.o2doneOpen;
    const revCount = (sc.workstreams||[]).filter(w=>w.rawState==='review' && stOfWs(sc, w)!=='blocked' && (!state.o2who || (w.owners||[]).includes(state.o2who))).length;
    const chips = [];
    if(openAsks > 0) chips.push(`<span class="o2-pchip warn"><i></i>${openAsks} 项需要你</span>`);
    chips.push(...(extraChips || []));
    if(revCount > 0) chips.push(`<span class="o2-pchip info"><i></i>${revCount} 项审阅中</span>`);
    if(openThreads !== null) chips.push(`<span class="o2-pchip">${openThreads} 条任务线进行中</span>`);
    else if(tot.running - revCount > 0) chips.push(`<span class="o2-pchip info"><i></i>${tot.running - revCount} 项活跃</span>`);
    const doneOrdered = doneWs.slice().sort((a,b)=>(b.seq||0)-(a.seq||0));
    const lim = state.o2doneAll ? doneOrdered.length : 8;
    const visDone = doneOrdered.slice(0, lim);
    const more = doneOrdered.length - visDone.length;
    const doneBody = visDone.length
      ? `<ul class="o2-donelist">${visDone.map(w=>{
          const c = itemCopy(w.id, w.title, w.note, w.short ?? null);
          const sub = c.line || cleanNote(w.note, '');
          return `<li><span class="o2-ti done" aria-label="已完成">✓</span><div class="o2-donem"><b>${esc(c.title)}</b>${sub?`<span>${esc(sub)}</span>`:''}</div>${workerBadges(w.owners, 2, sc)}</li>`;
        }).join('')}</ul>${more>0?`<button class="o2-more" data-o2="doneAll">${ui('more').replace('{n}', more)}</button>`:''}`
      : `<p class="o2-doneempty">暂无已完成任务。</p>`;
    const queuedBody = queuedWs.length
      ? `<div class="o2-queuedsub"><div class="o2-qhdr">待进行 · ${queuedWs.length}</div><ul class="o2-donelist queued">${queuedWs.slice(0,6).map(w=>{
          const c = itemCopy(w.id, w.title, w.note, w.short ?? null);
          return `<li><span class="o2-ti queued" aria-label="待进行"></span><div class="o2-donem"><b>${esc(c.title)}</b></div>${workerBadges(w.owners, 2, sc)}</li>`;
        }).join('')}</ul></div>`
      : '';
    return `<section class="o2-prog ${open?'open':''}">
      <button type="button" class="o2-progh" data-o2="doneOpen" aria-expanded="${open}">
        ${ringSvg(tot)}
        <span class="o2-progt"><b>${tot.done} / ${totalCount}</b> 项任务已完成</span>
        <span class="o2-progr">${chips.join('')}<span class="o2-chev" aria-hidden="true"></span></span>
      </button>
      ${open ? `<div class="o2-progb">${doneBody}${queuedBody}</div>` : ''}
    </section>`;
  }

  // Progress reel: only when the narrator listed frames (it does so for UI work only).
  function reelCard(sc){
    const R = sc.reel;
    if(!R || R.length<2) return '';
    const postAt = s => { const p=P.find(q=>q.s>=s); return p ? p.t : sc.now; };
    const doneAt = s => sc.workstreams.filter(w=>w.state==='done' && w.seq<=s).length;
    const total = sc.workstreams.length;
    const F = R.map(f=>({src:f.src, cap:f.caption, when:new Date(postAt(f.seq)).toLocaleString('zh-CN', {weekday:'short', hour:'numeric', minute:'2-digit'}), done:doneAt(f.seq), total}));
    const i = Math.min(F.length-1, Math.max(0, state.o2reel ?? F.length-1)); const f = F[i];
    return `<section class="o2-reel" data-reel="${esc(JSON.stringify(F))}">
      <div class="o2-rh"><span class="o2-glbl">${ui('progress')}</span><span class="o2-rwhen">${esc(f.when)}</span><button class="o2-btn o2-rcmp" aria-pressed="${!!state.o2reelCmp}">${state.o2reelCmp ? ui('hide_compare') : ui('compare')}</button></div>
      <div class="o2-rstage"><img class="o2-rnow" src="${esc(F[F.length-1].src)}" alt=""><img class="o2-rimg" src="${esc(f.src)}" alt="${esc(f.cap)}"><i class="o2-rline" ${state.o2reelCmp?'':'hidden'}></i><input class="o2-rswipe" type="range" min="0" max="100" value="${state.o2reelSwipe ?? 50}" aria-label="对比前后画面" ${state.o2reelCmp?'':'hidden'}><span class="o2-rtag">${i===F.length-1?ui('now'):`${i+1} / ${F.length}`}</span><button class="o2-rexp" type="button" aria-label="${ui('expand')}" title="${ui('expand')}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
      <p class="o2-rcap">${esc(f.cap)}</p>
      <p class="o2-rmeta">${f.done} / ${total} 项任务已完成</p>
      <div class="o2-rtrack">${F.map((x,k)=>`<i style="left:${F.length>1?(k/(F.length-1)*100).toFixed(2):0}%"></i>`).join('')}<input class="o2-rscrub" type="range" min="0" max="${F.length-1}" value="${i}" step="1" aria-label="拖动查看进度"></div>
    </section>`;
  }

  function threadModel(sc){
    const goal = sc.goal || null;
    const threads = (sc.threads || []).filter(t=>t && Array.isArray(t.workstreams));
    return threads.length ? {goal, threads} : null;
  }
  function threadsView(sc, TM){
    const wsById = new Map(sc.workstreams.map(w=>[w.id, w]));
    const attById = new Map(sc.attention.filter(a=>a.id).map(a=>[a.id, a]));
    const openYou = a => !sc.finished && a && a.wait==='you';
    const openAsk = a => !sc.finished && a && a.wait==='coordinator';
    const openIssue = a => !sc.finished && a && a.wait==='issue';
    if (state.o2who && (!Object.hasOwn(sc.members, state.o2who) || sc.members[state.o2who].killed)) state.o2who = null;
    const who = state.o2who || null;
    const stOf = w => { if(w.state!=='done' && w.state!=='blocked'){ const o=w.owners[0]; const m=Object.hasOwn(sc.members, o) ? sc.members[o] : null; if(m && m.status==='waiting_on') return 'blocked'; } return TSTATE[w.state]||'queued'; };
    // Who a held-up task waits on: the narrator's blocked_on, or the member its
    // worker asked and has not heard back from.
    const waiterOf = w => { if(stOf(w)!=='blocked') return null; const o=w.owners[0]; const m=Object.hasOwn(sc.members, o) ? sc.members[o] : null; return (w.state==='blocked' && w.blocked_on) || (m && m.waiting_on) || null; };
    const all = []; const used = new Set();
    const runningWs = [], doneWs = [], queuedWs = [];
    const seenWs = new Set();
    const collectWs = w => {
      if(seenWs.has(w.id)) return;
      seenWs.add(w.id);
      const s = stOf(w);
      all.push(s);
      if(s==='running' || s==='blocked') runningWs.push({w, st:s});
      else if(s==='done') doneWs.push(w);
      else queuedWs.push(w);
    };
    const rows = TM.threads.map(t=>{
      const ws = t.workstreams.map(id=>wsById.get(id)).filter(Boolean).filter(w=>!who || w.owners.includes(who));
      ws.forEach(w=>{ used.add(w.id); collectWs(w); });
      const att = (t.attention||[]).map(id=>attById.get(id)).filter(a=>!who || (a && a.from===who));
      const you = att.filter(openYou), asks = [...you, ...att.filter(openAsk)], issues = att.filter(openIssue);
      const n = {done:0, running:0, blocked:0, queued:0}; ws.forEach(w=>{ n[stOf(w)]++; });
      const waiters = new Set([...(asks.some(openAsk) ? ['coordinator'] : []), ...ws.map(waiterOf).filter(Boolean)]);
      const state = you.length ? 'needs' : (waiters.size || n.blocked) ? 'waiting' : issues.length ? 'stuck' : (n.running ? 'running' : (n.queued && !n.done ? 'queued' : (n.queued ? 'running' : 'done')));
      return {t, ws, asks, issues, n, state, waiters};
    }).filter(r=>r.ws.length || r.asks.length || r.issues.length);
    // Tasks no thread lists, built before the loose asks below so an ask can
    // join its worker's task here too.
    const rest = sc.workstreams.filter(w=>!used.has(w.id) && (!who || w.owners.includes(who)));
    if(rest.length){ const n={done:0,running:0,blocked:0,queued:0}; rest.forEach(w=>{ collectWs(w); n[stOf(w)]++; }); const waiters=new Set(rest.map(waiterOf).filter(Boolean));
      rows.push({t:{id:'t-other', title: TM.threads.length ? '其他' : '任务', goal:'', now:''}, ws:rest, asks:[], issues:[], waiters, n, state: (waiters.size || n.blocked) ? 'waiting' : n.running ? 'running' : (n.queued ? 'queued' : 'done')}); }
    // Asks no thread lists (system alerts included) still need to be seen.
    const listed = new Set(TM.threads.flatMap(t=>t.attention||[]));
    const loose = sc.attention.filter(a=>!a.id || !listed.has(a.id)).filter(a=>!who || a.from===who);
    const looseYou = loose.filter(openYou), looseAsks = loose.filter(openAsk), looseIssues = loose.filter(openIssue);
    if(looseYou.length) rows.push({t:{id:'t-you', title:ui('needs'), goal:'', now:''}, ws:[], asks:looseYou, issues:[], n:{done:0,running:0,blocked:0,queued:0}, state:'needs'});
    // A worker's ask goes in the thread with that worker's task, so it shows
    // once (next to the task that says "Waiting on @coordinator"); only asks
    // from workers with no task in a thread get their own group.
    const strayAsks = [];
    looseAsks.forEach(a=>{ const r=rows.find(x=>x.ws.some(w=>w.owners.includes(a.from)));
      if(r){ r.asks.push(a); r.waiters.add('coordinator'); if(r.state!=='needs') r.state='waiting'; } else strayAsks.push(a); });
    if(strayAsks.length) rows.push({t:{id:'t-waiting', title:waitOn('coordinator'), goal:'', now:''}, ws:[], asks:strayAsks, issues:[], n:{done:0,running:0,blocked:0,queued:0}, state:'waiting', waiters:new Set(['coordinator'])});
    if(looseIssues.length) rows.push({t:{id:'t-stuck', title:ui('stuck'), goal:'', now:''}, ws:[], asks:[], issues:looseIssues, n:{done:0,running:0,blocked:0,queued:0}, state:'stuck', waiters:new Set()});
    const order = {needs:0, waiting:1, stuck:2, running:3, queued:4, done:5};
    rows.sort((a,b)=>order[a.state]-order[b.state]);
    runningWs.sort((a,b)=>(a.st==='blocked'?0:1)-(b.st==='blocked'?0:1));
    const tot = {done:0,running:0,blocked:0,queued:0}; all.forEach(s=>tot[s]++);
    const LABEL = {needs:ui('needs'), stuck:ui('stuck'), running:'进行中', queued:'未开始', done:'已完成'};
    const labelOf = r => r.state!=='waiting' ? LABEL[r.state] : r.waiters.size===1 ? waitOn([...r.waiters][0]) : r.waiters.size>1 ? `等待 ${r.waiters.size} 位成员` : '等待中';
    const ICON = {done:'✓', running:'', blocked:'', queued:''};
    const ST_ARIA = {done:'已完成', running:'进行中', blocked:'阻塞', queued:'未开始'};
    const goalCopy = TM.goal || {};
    const goalTitle = goalCopy.title || clipWords(sc.headline, 9);
    const g = `<section class="o2-goal">
      <div class="o2-glbl">${ui('goal')}</div>
      <b>${esc(goalTitle)}</b>
      ${goalCopy.line ? `<p>${esc(goalCopy.line)}</p>` : ''}
    </section>`;
    const threadSummaryFallback = rows.filter(r=>r.state!=='done' && r.t.now).map(r=>r.t.now).slice(0,2).join(' · ');
    const openThreads = rows.filter(r=>r.state!=='done').length;
    const openAsks = rows.reduce((acc,r)=>acc+r.asks.filter(openYou).length, 0);
    // Count each waiting worker once per member it waits on, so a worker
    // whose ask and task both wait on the coordinator counts once.
    const pairs = new Set();
    rows.forEach(r=>r.asks.filter(openAsk).forEach(a=>pairs.add(`${a.from}>coordinator`)));
    runningWs.forEach(({w})=>{ const x=waiterOf(w); if(x) pairs.add(`${w.owners[0]}>${x}`); });
    const waits = new Map(); pairs.forEach(k=>{ const n=k.slice(k.indexOf('>')+1); waits.set(n, (waits.get(n)||0)+1); });
    const stuckN = rows.reduce((acc,r)=>acc+r.issues.length, 0);
    const runHtml = runningCard(sc, runningWs, threadSummaryFallback, goalTitle, goalCopy.line||'');
    const progHtml = progressCard(sc, tot, doneWs, queuedWs, openThreads, openAsks, waitChips(waits, stuckN));
    const thread = r => { const id=r.t.id; const open = r.ws.length>0 && (state['o2t:'+id] ?? (r.state==='needs' || r.state==='waiting' || r.state==='stuck'));
      const sum = r.n.done+r.n.running+r.n.blocked+r.n.queued;
      const asks = [...r.asks, ...r.issues].map(a=>{ const c=itemCopy(a.id, a.title, a.why, a.short ?? null); const on = (a.wait==='coordinator' && r.t.id!=='t-waiting' && !r.ws.some(w=>w.owners.includes(a.from))) ? `<span class="o2-askon">${esc(waitOn('coordinator'))}</span>` : '';
        // Opens the cited post on the Board (app.js handles data-ov-seq), else the member it is from.
        return `<button type="button" class="o2-ask ${a.wait==='issue'?'issue':''}" ${a.post ? `data-ov-seq="${a.post}"` : `data-open-member="${esc(a.from)}"`}><span class="o2-askd" aria-hidden="true"></span><span class="o2-askb"><b>${esc(c.title)}</b><span class="o2-askl">${esc(c.line)}</span>${on}</span></button>`; }).join('');
      const tasks = r.ws.slice().sort((a,b)=>({blocked:0,running:1,queued:2,done:3}[stOf(a)]-({blocked:0,running:1,queued:2,done:3}[stOf(b)]))).map(w=>{ const s=stOf(w); const c=itemCopy(w.id, w.title, w.note, w.short ?? null); return `<li class="${s}"><span class="o2-ti ${s}" aria-label="${ST_ARIA[s]||s}">${ICON[s]}</span><span class="o2-tt">${esc(c.title)}${waiterOf(w) ? `<span class="o2-tw">${esc(waitOn(waiterOf(w)))}</span>` : ''}</span>${taskProgressPill(w)}${workerBadges(w.owners, 2, sc)}</li>`; }).join('');
      const head = `<span class="o2-thd ${r.state}" aria-hidden="true"></span>
          <span class="o2-tht"><b>${esc(r.t.title)}</b>${labelOf(r) !== r.t.title ? `<em>${esc(labelOf(r))}</em>` : ''}</span>
          <span class="o2-thc">${sum ? `${miniBar(r.n)}<span>${r.n.done}/${sum}</span>` : `<span>${r.asks.length + r.issues.length}</span>`}</span>`;
      // Only the task list folds, so a thread without tasks gets no toggle.
      return `<section class="o2-th ${r.state} ${open?'open':''}">
        ${r.ws.length ? `<button class="o2-thh" data-o2t="${esc(id)}" aria-expanded="${open}">${head}<span class="o2-chev" aria-hidden="true"></span></button>` : `<div class="o2-thh">${head}</div>`}
        ${r.t.goal ? `<p class="o2-thg">${esc(r.t.goal)}</p>` : ''}
        ${r.t.now && r.state!=='done' ? `<p class="o2-thn"><span>${ui('now')}</span>${esc(r.t.now)}</p>` : (r.t.now ? `<p class="o2-thn done">${esc(r.t.now)}</p>` : '')}
        ${asks}
        ${open ? `<ul class="o2-tasks">${tasks}</ul>` : ''}
      </section>`; };
    return {goal:g, running:runHtml, progress:progHtml, reel: reelCard(sc), threads: rows.map(thread).join('')};
  }

  /* ---------- Members view: Board-style separated rows with Bees tiles ---------- */
  // Shared remote board: where the data comes from and whether it is current.
  function sourceChip(src, onlyProblems){
    if(!src || (onlyProblems && src.state==='live')) return '';
    const owners = Array.isArray(src.owners) ? src.owners : [];
    const label = src.label || '远程';
    const text = {live:`${label} · ${owners.length} 台机器`, stale:`${label} · 正在重新连接`, connecting:`${label} · 正在连接`, error:`${label} · 不可用`}[src.state] || label;
    const tip = [`共享 ${label} 看板 ${src.swarm_id||''}`, src.db||'', ...owners.map(o=>o&&o.label?String(o.label):''), src.error?`错误: ${src.error}`:''].filter(Boolean).join('\n');
    return `<div class="o2-src ${esc(src.state||'')}" data-testid="swarm-source" title="${esc(tip)}"><i aria-hidden="true"></i>${esc(text)}</div>`;
  }
  const agoText = ms => { const m=Math.round(ms/60000); if(m<1) return '刚刚在线'; if(m<60) return `${m} 分钟前在线`; const hr=Math.round(m/60); return hr<48 ? `${hr} 小时前在线` : `${Math.round(hr/24)} 天前在线`; };
  // Owner machine, last seen (for members on another machine) and channels.
  function memberTags(x){
    const tags = [];
    if(x.owner) tags.push(`<span class="o2-mtag" data-testid="swarm-member-owner" title="${esc(`运行于 ${x.owner.label}`)}">${esc(x.owner.label.includes('@') ? x.owner.label : '@'+x.owner.label)}</span>`);
    if(!x.local && x.last_seen) tags.push(`<span class="o2-mtag" data-testid="swarm-member-seen">${esc(agoText(Date.now()-x.last_seen))}</span>`);
    const chans = (x.channels||[]).filter(c=>c && c!=='main');
    if(chans.length) tags.push(`<span class="o2-mtag" data-testid="swarm-member-channels">${esc(chans.includes('*') ? '全部频道' : chans.map(c=>'#'+c).join(' '))}</span>`);
    return tags.length ? `<div class="o2-mtags">${tags.join('')}</div>` : '';
  }

  function membersView(sc){
    state.style = 'bees';
    const fmtMod = m => String(m||'').replace(/-(?:dropdown|high|medium)$/i,'');
    const allEntries = Object.entries(sc.members).filter(([,x])=>!x.system);
    const lead = sc.members.coordinator || {rawName:'coordinator', role:'coordinator', title:'协调者', status:'parked', now:'', posts:0};
    const workers = allEntries.filter(([n])=>n!=='coordinator');
    const liveWorkers = workers.filter(([,x])=>!x.killed);
    const retiredWorkers = workers.filter(([,x])=>x.killed).sort((a,b)=>(b[1].posts||0)-(a[1].posts||0));
    const isAct = x => !sc.finished && (x.status==='needs_you' || x.status==='working' || x.status==='waiting_on' || !!x.issue);
    const actOrder = {needs_you:0, working:1, waiting_on:2, parked:3};
    const activeWorkers = liveWorkers.filter(([,x])=>isAct(x)).sort((a,b)=>actOrder[a[1].status]-actOrder[b[1].status] || (b[1].posts||0)-(a[1].posts||0));
    const standbyWorkers = liveWorkers.filter(([,x])=>!isAct(x)).sort((a,b)=>((b[1].last?.seq||0)-(a[1].last?.seq||0)) || a[0].localeCompare(b[0]));

    const searchIcon = `<svg class="icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.25 10.25 3.25 3.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    const topBar = `${sourceChip(sc.source)}<div class="o2-mtop">
      <label class="o2-msearch">${searchIcon}<input type="search" class="o2-msin" placeholder="搜索成员" aria-label="搜索成员" autocomplete="off" value="${esc(state.o2mq||'')}"></label>
    </div>`;

    const leftBeeTile = (n, x) => {
      const st = sc.finished || x.killed ? '' : x.status;
      const dot = (st==='working' || st==='needs_you' || st==='waiting_on') ? `<i class="o2-mavd ${st}" aria-hidden="true"></i>` : '';
      return `<span class="o2-mav bee" style="${hexBG(n)}" aria-hidden="true">${spriteTag(n, x.killed?'landed':(sc.finished?'landed':x.status))}${dot}</span>`;
    };

    const rowHtml = (n, x) => {
      const isCoord = n==='coordinator';
      const st = (sc.finished || x.killed) ? 'parked' : x.status;
      const metaParts = [];
      const mod = fmtMod(x.model);
      if(mod) metaParts.push(mod);
      if(x.last && x.last.seq) metaParts.push('#'+x.last.seq);
      else if(x.posts) metaParts.push(x.posts + ' 条消息');
      const meta = metaParts.join(' · ');

      let statTag = '';
      let statLabelZh = '';
      if(isCoord){
        statLabelZh = st==='needs_you' ? ui('needs') : st==='working' ? '协调者 · 工作中' : '协调者';
        statTag = st==='needs_you' ? `<span class="o2-mstat warn">${statLabelZh}</span>` : st==='working' ? `<span class="o2-mstat info">${statLabelZh}</span>` : `<span class="o2-mstat">${statLabelZh}</span>`;
      } else if(x.killed){
        statLabelZh = x.title || '已退出';
        statTag = `<span class="o2-mstat">${esc(statLabelZh)}</span>`;
      } else if(x.issue && !sc.finished){
        statLabelZh = x.issue.kind==='stuck' ? '受阻' : '错误';
        statTag = `<span class="o2-mstat bad"${x.failure?.text ? ` title="${esc(x.failure.text)}"` : ''}>${statLabelZh}</span>`;
      } else if(x.failure && !sc.finished){
        statLabelZh = x.failure.kind==='quota' ? '额度耗尽' : '错误';
        statTag = `<span class="o2-mstat bad"${x.failure.text ? ` title="${esc(x.failure.text)}"` : ''}>${statLabelZh}</span>`;
      } else if(st==='working'){
        statLabelZh = '工作中';
        statTag = `<span class="o2-mstat info">${statLabelZh}</span>`;
      } else if(st==='waiting_on' && x.waiting_on){
        statLabelZh = waitOn(x.waiting_on);
        statTag = `<span class="o2-mstat warn">${esc(statLabelZh)}</span>`;
      } else if(x.title){
        statLabelZh = x.title;
        statTag = `<span class="o2-mstat">${esc(statLabelZh)}</span>`;
      }

      const hasIssue = !isCoord && !!x.issue && !sc.finished;
      const showRoleSub = !isCoord && !x.killed && (st==='working' || st==='waiting_on' || hasIssue) && x.title;
      let bodyLine = isCoord ? (x.now || memberLine('coordinator', x)) : (x.now || '');
      let rawBodyLine = x.rawNow || '';
      if(isCoord && st==='needs_you' && x.ask){
        bodyLine = x.ask.id==='sys-coordinator-reply' ? '正在对话中等待你的回复' : x.ask.title;
        rawBodyLine = x.ask.id==='sys-coordinator-reply' ? 'Waiting for your reply in chat' : (x.ask.rawTitle || '');
      } else if(x.ask && (st==='needs_you' || st==='waiting_on')){
        const ac = itemCopy(x.ask.id, x.ask.title, x.ask.why, x.ask.short ?? null);
        bodyLine = ac.line ? `${ac.title} — ${ac.line}` : ac.title;
        const rTitle = x.ask.rawShort?.title || (x.ask.rawTitle ? clipWords(x.ask.rawTitle, 7) : '');
        const rLine = x.ask.rawShort?.line || (x.ask.rawWhy ? clipWords(firstClause(x.ask.rawWhy), 12) : '');
        rawBodyLine = rTitle ? (rLine ? `${rTitle} — ${rLine}` : rTitle) : rLine;
      } else if(hasIssue){
        bodyLine = itemCopy(x.issue.id, x.issue.title, x.issue.why, x.issue.short ?? null).line || x.issue.title;
        rawBodyLine = x.issue.rawShort?.line || (x.issue.rawWhy ? clipWords(firstClause(x.issue.rawWhy), 12) : '') || x.issue.rawTitle || '';
      } else if(!sc.finished && !x.killed && x.failure?.text){
        bodyLine = x.failure.text;
        rawBodyLine = x.failure.rawText || '';
      }

      const hay = `${n} ${x.rawName||''} ${x.title||''} ${x.rawTitle||''} ${x.zhTitle||''} ${x.model||''} ${bodyLine||''} ${rawBodyLine||''} ${x.failure?.rawText||''} ${x.failure?.zhText||''} ${x.rawNow||''} ${x.zhNow||''} ${x.live?.text||''} ${x.live?.rawText||''} ${x.live?.zhText||''} ${statLabelZh} ${st}`;
      // A working member's live step, set apart from the last-post fallback.
      // toModel sets `live` only for members still at work (and the
      // coordinator, which an unattributed ask marks needs_you).
      // A stuck or failed member's step is not live, so show what is wrong.
      const live = !sc.finished && !x.killed && !hasIssue && x.live ? x.live : null;
      const nowHtml = live
        ? `<div class="o2-mnow o2-mact ${esc(live.kind)}" data-testid="swarm-member-activity" title="${esc(liveTip(live))}">${liveText(live)}</div>`
        : (bodyLine ? `<div class="o2-mnow">${esc(bodyLine)}</div>` : '');
      const openAttr = `data-open-member="${esc(x.rawName || n)}"`;
      const cls = `o2-mrow bees ${st} ${hasIssue?'issue':''} ${x.killed?'retired':''} ${isCoord?'coord':''}`;

      return `<article class="${cls}" ${openAttr} data-mhay="${esc(hay)}">
        ${leftBeeTile(n, x)}
        <div class="o2-mcol">
          <header class="o2-mhead">
            <span class="o2-mwho"><span class="o2-mauth">@${esc(isCoord?'coordinator':n)}</span>${statTag}</span>
            <span class="o2-mright">${meta?`<span class="o2-mts">${esc(meta)}</span>`:''}</span>
          </header>
          ${showRoleSub ? `<div class="o2-mrole">${esc(x.title)}</div>` : ''}
          ${memberTags(x)}
          ${nowHtml}
        </div>
      </article>`;
    };

    const groupHtml = (label, list) => list.length
      ? `<section class="o2-mgroup"><h3 class="o2-msec"><span>${label}</span><em>${list.length}</em></h3><div class="o2-mlist">${list.map(([n,x])=>rowHtml(n,x)).join('')}</div></section>`
      : '';

    const retOpen = !!state.o2mRetired;
    const retiredHtml = retiredWorkers.length
      ? `<section class="o2-mgroup o2-mretgrp ${retOpen?'open':''}">
          <button type="button" class="o2-mret" data-o2="mRetired" aria-expanded="${retOpen}">
            <span>已退出成员</span><em>${retiredWorkers.length}</em><span class="o2-chev" aria-hidden="true"></span>
          </button>
          ${retOpen ? `<div class="o2-mlist">${retiredWorkers.map(([n,x])=>rowHtml(n,x)).join('')}</div>` : ''}
        </section>`
      : '';

    return `<div class="o2 o2-members">
      ${topBar}
      <section class="o2-mgroup o2-mcoord">${rowHtml('coordinator', lead)}</section>
      ${groupHtml('活跃成员', activeWorkers)}
      ${groupHtml(sc.finished ? '团队成员' : '待命成员', standbyWorkers)}
      ${retiredHtml}
    </div>`;
  }

  // First run: no narrator view and no worker has posted yet. Shows how a swarm
  // works with the swarm's own bees (placeholders until workers join).
  function onboardView(sc){
    const real = people(sc).filter(([n,x])=>n!=='coordinator' && !x.killed).map(([n])=>n).slice(0,3);
    const ws = [...real, ...['worker-a','worker-b','worker-c']].slice(0,3);
    const Y = [30, 78, 126];
    const path = (y,i) => `<path id="o2-onb-p${i}" d="M84 78 C150 78 160 ${y} 226 ${y}"/>`;
    const dot = (i, fill, back, begin) => `<circle r="3" fill="${fill}" opacity="0"><animateMotion dur="2.4s" begin="${begin}s" repeatCount="indefinite" keyPoints="${back?'1;0':'0;1'}" keyTimes="0;1" calcMode="linear"><mpath href="#o2-onb-p${i}"/></animateMotion><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="2.4s" begin="${begin}s" repeatCount="indefinite"/></circle>`;
    const bee = (n, cls, style) => `<span class="o2-mav bee ${cls}" style="${hexBG(n)};${style}">${spriteTag(n,'working')}</span>`;
    const icon = n => `<span class="o2-onb-i" style="${hexBG(n)}"><img src="${beeImg(n)}" alt="" width="22" height="18"></span>`;
    return `<section class="o2-onb" data-testid="swarm-onboarding">
      <div class="o2-onb-stage" aria-hidden="true">
        <svg class="o2-onb-paths" viewBox="0 0 320 156" width="320" height="156">
          <g class="o2-onb-lines">${Y.map(path).join('')}</g>
          ${ws.map((n,i)=>dot(i, tcol('coordinator'), false, i*0.8) + dot(i, tcol(n), true, i*0.8+1.2)).join('')}
        </svg>
        ${bee('coordinator', 'o2-onb-q', 'left:24px;top:56px')}
        ${ws.map((n,i)=>bee(n, `o2-onb-w s${i}`, `left:236px;top:${Y[i]-22}px`)).join('')}
      </div>
      <h2 class="o2-onb-h">Swarm 正在启动</h2>
      <ol class="o2-onb-steps">
        <li>${icon('coordinator')}<div><b>一个目标</b><span>协调者将目标拆分为任务。</span></div></li>
        <li>${icon(ws[0])}<div><b>多位执行者</b><span>每位执行者负责一项任务，并行开展工作。</span></div></li>
        <li>${icon(ws[1])}<div><b>一个共享看板</b><span>进展会汇集到这里。需要您参与时才会请您介入。</span></div></li>
      </ol>
      <p class="o2-onb-wait"><span class="animate-shimmer-text">等待首次更新</span></p>
    </section>`;
  }

  function overviewView(sc){
    state.style = 'bees';
    const att = k => sc.finished ? [] : sc.attention.filter(a=>a.wait===k);
    const you = att('you'), hot = att('coordinator'), issues = att('issue');
    const open = sc.workstreams.filter(w=>w.state!=='done');
    const items = [];
    open.forEach(w=>{
      let why=null;
      if(w.state==='blocked') why={kind:'agent', who:w.owners[0], on:w.blocked_on||null, seq:w.seq};
      else if(w.state==='active'){ for(const o of w.owners){ const m=Object.hasOwn(sc.members, o) ? sc.members[o] : null; if(m && m.status==='waiting_on'){ why={kind:'agent', who:o, on:m.waiting_on, seq:m.waiting_seq}; break; } } }
      items.push({id:w.id, title:w.title, line:w.note, short:w.short ?? null, owner:w.owners[0], owners:w.owners, why, group: why ? 'blocked' : (w.state==='queued' ? 'planned' : 'running')});
    });
    if (state.o2who && (!Object.hasOwn(sc.members, state.o2who) || sc.members[state.o2who].killed)) state.o2who = null;
    const who = state.o2who || null;
    const mine = list => who ? list.filter(i=>(i.owners||[i.owner]).includes(who)) : list;
    const G = k => mine(items.filter(i=>i.group===k));
    const running=G('running');

    const M = n => (sc.members && Object.hasOwn(sc.members, n) && sc.members[n]) || {status:'parked', now:''};
    const art = (n) => { const x=M(n); return spriteTag(n, x.killed ? 'landed' : (sc.finished?'landed':x.status)); };
    const tile = (n, cls) => `<span class="o2-tile ${cls||''} bees" style="${hexBG(n)}">${art(n)}</span>`;

    // The team (Bees only, no style picker)
    const lead = M('coordinator');
    const crew = [...people(sc)].filter(([n,x])=>n!=='coordinator' && !x.killed)
      .sort((a,b)=>ORDER[a[1].status]-ORDER[b[1].status]);
    const MAXT = 5; let shown = crew.length>MAXT+1 ? crew.slice(0,MAXT) : crew;
    if(who && !shown.some(([n])=>n===who)){ const sel=crew.find(([n])=>n===who); if(sel) shown=[...shown.slice(0,MAXT-1), sel]; }
    const extra = crew.length-shown.length;
    const trio = crew.slice(0,3).map(([n])=>n);
    const swarmArt = `<span class="o2-swarm">${trio.map((n,i)=>`<span class="o2-sb s${i}">${spriteTag(n, sc.finished?'landed':'working')}</span>`).join('')}</span>`;
    const allTile = `<button class="o2-m all ${who?'':'on'}" aria-pressed="${!who}" title="所有执行成员" data-o2who=""><span class="o2-tile sm all bees">${swarmArt}</span><span>全部</span></button>`;
    const team = `<section class="o2-team">
      <h3 class="o2-h">${ui('team')}</h3>
      <div class="o2-lead">${tile('coordinator','lg')}<div class="o2-lb"><b>${ui('lead')}</b>${lead.live && !sc.finished ? `<p class="o2-live" title="${esc(liveTip(lead.live))}">${liveText(lead.live, memberLine('coordinator', lead))}</p>` : `<p>${esc(memberLine('coordinator', lead))}</p>`}</div></div>
      ${crew.length ? `<div class="o2-crew" role="group" aria-label="按执行成员筛选">${allTile}${shown.map(([n,x])=>`<button class="o2-m ${sc.finished?'':x.status} ${who===n?'on':''}" aria-pressed="${who===n}" title="${esc(n)}: ${esc(memberLine(n,x))}" data-o2who="${esc(n)}">${tile(n,'sm')}<i class="o2-st" aria-hidden="true"></i><span>@${esc(n)}</span></button>`).join('')}${extra>0?`<button class="o2-m more" id="o2More"><span class="o2-tile sm plus">+${extra}</span><span>&nbsp;</span></button>`:''}</div>` : ''}
    </section>`;

    const card = it => { const c=itemCopy(it.id, it.title, it.line, it.short ?? null);
      return `<div class="o2-card">${tile(it.owner,'md')}<div class="o2-cb"><b>${esc(c.title)}</b><p>${esc(c.line)}</p><div class="o2-who">@${esc(it.owner)}</div></div></div>`; };
    const branch = (k, list, none, limit) => { const lim=state['o2'+k]?list.length:limit; const vis=list.slice(0,lim); const more=list.length-vis.length;
      return `<section class="o2-br ${k}"><h3 class="o2-h"><i></i>${ui(k)}<em>${list.length}</em></h3>
        ${list.length ? `<div class="o2-cards">${vis.map(card).join('')}</div>${more>0?`<button class="o2-more" data-o2="${k}">${ui('more').replace('{n}',more)}</button>`:''}` : `<p class="o2-none">${ui(none)}</p>`}</section>`; };

    if(sc.starting) return `<div class="o2">${sourceChip(sc.source, true)}${onboardView(sc)}${team}</div>`;
    // One layout for every swarm: goal, running, done, timeline, threads, the
    // team. Without narrator or plan threads, the tasks sit in one group.
    // Builds without the built-in Overview keep the card layout until a
    // narrator writes threads.
    const TM = threadModel(sc);
    if(!TM && !sc.builtin){
      const stOf = w => { if(w.state!=='done' && w.state!=='blocked'){ const o=w.owners[0]; const m=Object.hasOwn(sc.members, o) ? sc.members[o] : null; if(m && m.status==='waiting_on') return 'blocked'; } return TSTATE[w.state]||'queued'; };
      const tot = {done:0, running:0, blocked:0, queued:0};
      const run = [], done = [], queued = [];
      sc.workstreams.filter(w=>!who || w.owners.includes(who)).forEach(w=>{ const st=stOf(w); tot[st]++; if(st==='running'||st==='blocked') run.push({w, st}); else if(st==='done') done.push(w); else queued.push(w); });
      const toItem = a=>({id:a.id||('ask-'+a.seq), title:a.title, line:a.why, short:a.short ?? null, owner:a.from, owners:[a.from]});
      const needs = mine(you.map(toItem)), waiting = mine(hot.map(toItem)), stuck = mine(issues.map(toItem));
      const waits = new Map(); const bump = n => waits.set(n, (waits.get(n)||0)+1);
      waiting.forEach(()=>bump('coordinator'));
      run.forEach(({w})=>{ const x = w.state==='blocked' ? w.blocked_on : ((Object.hasOwn(sc.members, w.owners[0]) && sc.members[w.owners[0]]) || {}).waiting_on; if(x && (w.state==='blocked' || stOf(w)==='blocked')) bump(x); });
      return `<div class="o2">${sourceChip(sc.source, true)}${needs.length ? branch('needs', needs, 'none_needs', 3) : ''}${waiting.length ? branch('waiting', waiting, 'none_waiting', 3) : ''}${stuck.length ? branch('stuck', stuck, 'none_stuck', 3) : ''}${runningCard(sc, run, '', '', '') || branch('running', running, 'none_running', 3)}${progressCard(sc, tot, done, queued, null, needs.length, waitChips(waits, stuck.length))}${reelCard(sc)}${team}</div>`;
    }
    const v = threadsView(sc, TM || {goal: sc.goal, threads: []});
    return `<div class="o2">${sourceChip(sc.source, true)}${v.goal}${v.running}${v.progress}${v.reel}<section class="o2-threads"><h3 class="o2-h">${ui('threads')}</h3>${v.threads}</section>${team}</div>`;
  }

  /* ---------- render ---------- */
  function render(el, view) {
    const sc = S.live;
    if (!sc) return;
    const v = view === 'cards' ? 'cards' : 'overview';
    const active = document.activeElement;
    const typing = active && active.classList && active.classList.contains('o2-msin') && el.contains(active)
        ? {start: active.selectionStart, end: active.selectionEnd} : null;
    el.innerHTML = v === 'cards' ? membersView(sc) : overviewView(sc);
    el.dataset.view = v;
    paintSprites(el);
    requestAnimationFrame(() => snapBees(el));
    bind(el);
    if (typing) {
      const inp = el.querySelector('.o2-msin');
      if (inp) { inp.focus({preventScroll: true}); inp.setSelectionRange(typing.start, typing.end); }
    }
  }

  // Full view of the progress timeline: the whole screenshot (not cropped),
  // every frame in a filmstrip, arrow keys to step, Esc to close. Lives on
  // <body> so the 2 s re-render of the Overview does not tear it down.
  function closeReel() { const lb = $('.o2-tv'); if (lb) (lb.closeReel || (() => lb.remove()))(); }

  function openReel(F, start, onMove) {
    closeReel();
    if (!F.length) return;
    const back = document.activeElement;
    const lb = document.createElement('div');
    lb.className = 'o2-tv'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', ui('progress'));
    lb.innerHTML = `<div class="o2-tvh"><b>${ui('progress')}</b><span class="o2-tvpos"></span><span class="o2-tvwhen"></span><button class="o2-tvx" type="button" aria-label="关闭">\u2715</button></div>
      <div class="o2-tvstage"><div class="o2-tvscroll"><img class="o2-tvimg" alt=""></div><button class="o2-tvnav prev" type="button" aria-label="上一帧">\u2039</button><button class="o2-tvnav next" type="button" aria-label="下一帧">\u203a</button></div>
      <div class="o2-tvtext"><p class="o2-tvcap"></p><p class="o2-tvmeta"></p></div>
      <div class="o2-tvstrip" role="listbox" aria-label="画面列表">${F.map((f, k) => `<button class="o2-tvth" type="button" role="option" data-k="${k}" aria-label="${esc(`${k + 1}. ${f.cap || ''}`)}"><img src="${esc(f.src)}" alt="" loading="lazy"><span>${k + 1}</span></button>`).join('')}</div>`;
    document.body.appendChild(lb);
    const img = $('.o2-tvimg', lb), scroller = $('.o2-tvscroll', lb), strip = $('.o2-tvstrip', lb);
    let i = -1;
    // Only real steps re-render the card; opening and pressing past either end
    // leave it alone (a re-render would detach the opener and drop zoom).
    const go = (k, opening) => {
      const n = Math.max(0, Math.min(F.length - 1, k));
      if (n === i) return;
      i = n; const f = F[i];
      scroller.classList.remove('zoom');
      img.src = f.src; img.alt = f.cap || '';
      $('.o2-tvpos', lb).textContent = i === F.length - 1 ? `${ui('now')} \u00b7 ${i + 1} / ${F.length}` : `${i + 1} / ${F.length}`;
      $('.o2-tvwhen', lb).textContent = f.when || '';
      $('.o2-tvcap', lb).textContent = f.cap || '';
      $('.o2-tvmeta', lb).textContent = f.total ? `${f.done} / ${f.total} 项任务已完成` : '';
      $('.o2-tvnav.prev', lb).disabled = i === 0; $('.o2-tvnav.next', lb).disabled = i === F.length - 1;
      strip.querySelectorAll('.o2-tvth').forEach((b, k2) => { const on = k2 === i; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); if (on) b.scrollIntoView({block: 'nearest', inline: 'center'}); });
      if (onMove && !opening) onMove(i);
    };
    // The Overview may have re-rendered since this opened, so focus falls back
    // to the live expand button when the opener is gone.
    const close = () => {
      document.removeEventListener('keydown', key, true); lb.remove();
      const to = back && back.isConnected ? back : $('.o2-reel .o2-rexp');
      if (to && to.focus) to.focus({preventScroll: true});
    };
    lb.closeReel = close;
    const key = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
      else if (e.key === 'Home') { e.preventDefault(); go(0); }
      else if (e.key === 'End') { e.preventDefault(); go(F.length - 1); }
    };
    document.addEventListener('keydown', key, true);
    $('.o2-tvx', lb).onclick = close;
    $('.o2-tvnav.prev', lb).onclick = () => go(i - 1);
    $('.o2-tvnav.next', lb).onclick = () => go(i + 1);
    strip.querySelectorAll('.o2-tvth').forEach(b => b.onclick = () => go(+b.dataset.k));
    // Click the picture to see it at full size; click again to fit.
    img.onclick = () => scroller.classList.toggle('zoom');
    lb.onclick = e => { if (e.target === lb || e.target === scroller) close(); };
    go(start, true);
    lb.tabIndex = -1; lb.focus({preventScroll: true});
  }

  function bind(el) {
    const hooks = (window.SwarmHive && window.SwarmHive.hooks) || {};
    el.querySelectorAll('.o2-reel').forEach(r => {
      let F = [];
      try { F = JSON.parse(r.dataset.reel || '[]'); } catch (_) {}
      const img = r.querySelector('.o2-rimg'), scrub = r.querySelector('.o2-rscrub'), sw = r.querySelector('.o2-rswipe'),
          line = r.querySelector('.o2-rline'), cmp = r.querySelector('.o2-rcmp');
      const show = i => {
        const f = F[i]; if (!f) return;
        img.src = f.src; img.alt = f.cap;
        r.querySelector('.o2-rcap').textContent = f.cap;
        r.querySelector('.o2-rwhen').textContent = f.when;
        r.querySelector('.o2-rmeta').textContent = `${f.done} / ${f.total} 项任务已完成`;
        r.querySelector('.o2-rtag').textContent = i === F.length - 1 ? ui('now') : `${i + 1} / ${F.length}`;
        state.o2reel = i;
      };
      const clip = () => {
        const on = cmp.getAttribute('aria-pressed') === 'true';
        img.style.clipPath = on ? `inset(0 ${100 - sw.value}% 0 0)` : 'none';
        line.style.left = sw.value + '%';
      };
      scrub.oninput = () => show(+scrub.value);
      sw.oninput = () => { state.o2reelSwipe = +sw.value; clip(); };
      if (state.o2reelCmp) clip();
      // Steps go through state and a re-render: a poll may have replaced this
      // card's nodes while the viewer is open.
      const open = () => openReel(F, state.o2reel ?? F.length - 1, i => { state.o2reel = i === F.length - 1 ? null : i; sync(); });
      r.querySelector('.o2-rexp').onclick = (e) => { e.stopPropagation(); open(); };
      img.onclick = () => { if (cmp.getAttribute('aria-pressed') !== 'true') open(); };
      cmp.onclick = () => {
        const on = cmp.getAttribute('aria-pressed') !== 'true';
        state.o2reelCmp = on;
        cmp.setAttribute('aria-pressed', on);
        cmp.textContent = on ? ui('hide_compare') : ui('compare');
        sw.hidden = !on; line.hidden = !on; clip();
      };
    });
    el.querySelectorAll('[data-o2t]').forEach(b => b.onclick = (e) => {
      e.stopPropagation(); state['o2t:' + b.dataset.o2t] = b.getAttribute('aria-expanded') !== 'true'; sync();
    });
    el.querySelectorAll('[data-o2who]').forEach(b => b.onclick = (e) => {
      e.stopPropagation(); const n = b.dataset.o2who; state.o2who = (n && state.o2who !== n) ? n : null; sync();
    });
    el.querySelectorAll('[data-o2]').forEach(b => b.onclick = (e) => {
      e.stopPropagation(); const k = 'o2' + b.dataset.o2; state[k] = !state[k]; sync();
    });
    const om = $('#o2More', el);
    if (om) om.onclick = () => { if (hooks.members) hooks.members(); };
    el.querySelectorAll('[data-open-member]').forEach(b => b.onclick = (e) => {
      const btn = e.target.closest('button');
      if (btn && btn !== b) return;
      if (hooks.member) hooks.member(b.dataset.openMember);
    });
    el.querySelectorAll('.o2-msin').forEach(inp => {
      const apply = () => {
        const q = inp.value.trim().toLowerCase();
        state.o2mq = inp.value;
        el.querySelectorAll('.o2-mrow').forEach(row => {
          row.style.display = (!q || (row.dataset.mhay || '').toLowerCase().includes(q)) ? '' : 'none';
        });
        el.querySelectorAll('.o2-mgroup').forEach(grp => {
          grp.style.display = (!q || [...grp.querySelectorAll('.o2-mrow')].some(r => r.style.display !== 'none')) ? '' : 'none';
        });
      };
      inp.oninput = apply;
      if (inp.value) apply();
    });
  }

  /* ================= adapter: plugin snapshot -> view model ================= */
  function toModel(snap){
    const byName = new Map(snap.members.map(m=>[m.name,m]));
    const isRole = n => { const m=byName.get(n); return !!(m && (m.roleWorker || m.narrator)); };
    const leadM = snap.members.find(m=>m.role==='coordinator');
    const L = leadM ? leadM.name : 'coordinator';
    const key = n => n===L ? 'coordinator' : n;
    window.SwarmHive = window.SwarmHive || {}; window.SwarmHive.leadName = L;
    const msgs = snap.messages.filter(m=>!isRole(m.agent) && !(m.control && typeof m.control==='object'));
    P = msgs.map(m=>({ s:m.seq, a:key(m.agent), t:new Date(m.ts || Date.now()).toISOString(),
      to:(m.all?['*']:(m.mentions||[]).filter(n=>n!==m.agent && !isRole(n)).map(key)),
      x:String(m.text||'').replace(/\s+/g,' ').trim().slice(0,400),
      x_zh:m.text_zh ? String(m.text_zh).replace(/\s+/g,' ').trim().slice(0,400) : '' }));
    const head = snap.head || (P.length?P[P.length-1].s:0);
    const pickText = (zh, raw) => {
      const r = String(raw || '');
      if (zh && String(zh).trim()) return String(zh);
      return r ? tier1ClientFallback(r) : '';
    };
    const rawView = snap.rawView && typeof snap.rawView==='object' ? snap.rawView : (snap.view && snap.view.json && typeof snap.view.json==='object' ? snap.view.json : null);
    const rawPlan = snap.rawPlan && typeof snap.rawPlan==='object' ? snap.rawPlan : (snap.plan && typeof snap.plan==='object' ? snap.plan : null);
    const hasViewJson = !!(snap.view && snap.view.json && typeof snap.view.json==='object');
    const narratorView = snap._viewLocalized
      ? (hasViewJson ? snap.view.json : null)
      : (snap.view_zh && typeof snap.view_zh==='object' ? snap.view_zh : (hasViewJson ? snap.view.json : null));
    const hasLocalizedView = !!snap._viewLocalized || (!!snap.view_zh && narratorView === snap.view_zh);
    // Without a narrator view, the coordinator's plan.json supplies the goal,
    // the threads (lists of worker names) and each worker's task name. Live
    // status still comes from the board.
    const plan = !narratorView
      ? (snap._planLocalized
        ? (snap.plan && typeof snap.plan==='object' ? snap.plan : null)
        : (snap.plan_zh && typeof snap.plan_zh==='object' ? snap.plan_zh : rawPlan))
      : null;
    const hasLocalizedPlan = !!snap._planLocalized || (!!snap.plan_zh && plan === snap.plan_zh);
    const planTasks = plan && plan.tasks && typeof plan.tasks==='object' ? plan.tasks : {};
    const planTasksRaw = !narratorView && rawPlan && rawPlan.tasks && typeof rawPlan.tasks==='object' ? rawPlan.tasks : {};
    const vj = narratorView || (plan ? {
      goal: plan.goal,
      threads: (Array.isArray(plan.threads)?plan.threads:[]).filter(t=>t && t.title && Array.isArray(t.tasks))
          .map((t,i)=>({id: t.id || ('t'+i), title: t.title, goal: t.goal || '', workstreams: t.tasks.filter(n=>typeof n==='string').map(n=>n===L?'coordinator':n)})),
    } : {});
    const trViewStr = v => {
      const s = String(v || '');
      if (!s || hasLocalizedView) return s;
      return tier1ClientFallback(s);
    };
    const trPlanStr = v => {
      const s = String(v || '');
      if (!s || hasLocalizedPlan) return s;
      return tier1ClientFallback(s);
    };
    const team = snap.members.filter(m=>!m.roleWorker && !m.narrator);
    const cleanPath = str => String(str||'').replace(/(?:~\/\.gemini\/[\w.-]+\/brain|\/(?:usr\/local\/google\/home|google\/src\/cloud))\/[^\s`'")]+/g, m=>{
      const parts=m.split('/').filter(Boolean); return parts.length>=2 ? '…/'+parts.slice(-2).join('/') : m;
    });
    const clipW = (str, maxW) => {
      const s = String(str||'').replace(/\s+/g,' ').trim();
      if(!s) return '';
      if(CJK_CHAR_RE.test(s)){
        const maxChars = Math.max(8, maxW * 4);
        return s.length > maxChars ? s.slice(0, maxChars - 1).replace(/[，。；：、,;:.！？!]+$/,'') + '…' : s.replace(/[。！？；.!:]+$/,'');
      }
      const w = s.split(' ').filter(Boolean);
      return w.length > maxW ? w.slice(0, maxW).join(' ').replace(/[,;:.]+$/,'') + '…' : w.join(' ').replace(/[.:]+$/,'');
    };
    const briefOf = (n, useZh = false) => { const re=new RegExp('^@'+n.replace(/[.*+?^${}()|[\]\\-]/g,'\\$&')+'\\b'); const p=msgs.find(m=>m.agent===L && re.test(String(m.text||''))); if(!p) return '';
      const src = (useZh && p.text_zh) ? String(p.text_zh) : String(p.text);
      let s=src.replace(/^(?:\s*@[A-Za-z0-9_.-]+(?:\s*[,，:：、])?)+\s*/,'').replace(/\*\*([^*]+)\*\*/g,'$1').split(/(?<=[.!?])\s|(?<=[。！？；])\s*|\n/)[0];
      s=s.replace(/\s*\((?:you\b|your\b)[^)]*\)/gi,'').replace(/\s*\((?:you\b|your\b)[^)]*$/gi,'');
      s=s.replace(/^(?:you\s+(?:are|own|handle|drive|run|lead|manage)|your\s+(?:role|job|task|assignment|goal|focus)\s+is(?:\s+to)?|assignment\s*:|role\s*:|task\s*:)\s*/i,'');
      s=s.replace(/^(?:turning|making|building|auditing|fixing)\s+(?:the\s+)?/i, m=>m.charAt(0).toUpperCase()+m.slice(1));
      s=s.replace(/^(?:the|a|an|this\s+swarm's)\s+/i,'');
      s=clipW(cleanPath(s), 8);
      return s ? s.charAt(0).toUpperCase()+s.slice(1) : ''; };
    const lastPostBy = n => { for(let i=P.length-1;i>=0;i--) if(P[i].a===n) return P[i]; return null; };
    const KINDS=['decision','failure','review','stuck','quota','error','fyi'];
    const SEVS=['high','med','low'];
    const ITEM_ID_RE = /^[a-z0-9-]{1,40}$/;
    const rawAttId = x => (typeof x?.id === 'string' && ITEM_ID_RE.test(x.id) ? x.id : '');
    const rawAttKind = x => (KINDS.includes(x?.kind) ? x.kind : 'fyi');
    const rawAttSev = x => (SEVS.includes(x?.severity) ? x.severity : 'low');
    const rawAttList = Array.isArray(rawView?.attention) ? rawView.attention.filter(x => x && x.title) : [];
    const rawAttById = new Map(rawAttList.map(x => [rawAttId(x), x]).filter(([id]) => id));
    const attItems = (Array.isArray(vj.attention)?vj.attention:[]).filter(a=>a&&a.title);
    const usedRawAtt = new Set();
    const rawMatchForAtt = new Map();
    const refKeys = (item) => {
      const refs = Array.isArray(item?.refs) ? item.refs : [];
      const members = new Set(refs.filter(r => r && typeof r.member === 'string' && r.member).map(r => r.member));
      const seqs = new Set(refs.filter(r => r && Number.isFinite(Number(r.seq)) && Number(r.seq) > 0).map(r => Number(r.seq)));
      return { members, seqs };
    };
    if (!hasLocalizedView) {
      attItems.forEach(a => rawMatchForAtt.set(a, a));
    } else {
      attItems.forEach(a => {
        if (a.id) {
          const hit = rawAttById.get(String(a.id));
          if (hit) { rawMatchForAtt.set(a, hit); usedRawAtt.add(hit); }
        }
      });
      attItems.forEach(a => {
        if (a.id || rawMatchForAtt.has(a)) return;
        const { members: am, seqs: as } = refKeys(a);
        if (!am.size && !as.size) return;
        const aKind = rawAttKind(a);
        const aSev = rawAttSev(a);
        let best = null, bestScore = 0;
        for (const x of rawAttList) {
          if (rawAttId(x) || usedRawAtt.has(x) || rawAttKind(x) !== aKind) continue;
          const { members: xm, seqs: xs } = refKeys(x);
          let score = 0;
          for (const m of am) if (xm.has(m)) score += 4;
          for (const s of as) if (xs.has(s)) score += 2;
          if (score > 0 && rawAttSev(x) === aSev) score += 1;
          if (score > bestScore) { bestScore = score; best = x; }
        }
        if (best) { rawMatchForAtt.set(a, best); usedRawAtt.add(best); }
      });
      attItems.forEach(a => {
        if (a.id || rawMatchForAtt.has(a)) return;
        const aKind = rawAttKind(a);
        const aSev = rawAttSev(a);
        const hit = rawAttList.find(x => !rawAttId(x) && !usedRawAtt.has(x) && rawAttKind(x) === aKind && rawAttSev(x) === aSev);
        if (hit) { rawMatchForAtt.set(a, hit); usedRawAtt.add(hit); }
      });
      attItems.forEach(a => {
        if (a.id || rawMatchForAtt.has(a)) return;
        const aKind = rawAttKind(a);
        const hit = rawAttList.find(x => !rawAttId(x) && !usedRawAtt.has(x) && rawAttKind(x) === aKind);
        if (hit) { rawMatchForAtt.set(a, hit); usedRawAtt.add(hit); }
      });
    }
    const sh = x => x && typeof x.short==='object' && x.short ? {title:trViewStr(x.short.title||'').slice(0,60), line:trViewStr(x.short.line||'').slice(0,90)} : null;
    const attention = attItems.map(a=>{
      const refs=Array.isArray(a.refs)?a.refs:[]; const seqRef=refs.find(r=>r&&r.seq); const memRef=refs.find(r=>r&&r.member&&byName.has(r.member)&&byName.get(r.member).role!=='coordinator');
      const acts=Array.isArray(a.actions)?a.actions:[]; const p=seqRef?P.find(q=>q.s===seqRef.seq):null; const url=acts.find(x=>x&&x.type==='url');
      // The narrator's own jump target beats the first cited post.
      const jump=acts.find(x=>x&&x.type==='board_post'&&P.some(q=>q.s===Number(x.target)));
      const rawA = rawMatchForAtt.get(a) || null;
      const rawShort = rawA && rawA.short && typeof rawA.short === 'object'
        ? { title: String(rawA.short.title || '').slice(0, 60), line: String(rawA.short.line || '').slice(0, 90) }
        : null;
      return { id: a.id ? String(a.id) : null, kind:KINDS.includes(a.kind)?a.kind:'fyi', severity:a.severity||'low', title:trViewStr(a.title).slice(0,160), why:trViewStr(a.why||'').slice(0,300), short: sh(a), rawTitle: rawA ? String(rawA.title || '').slice(0,160) : '', rawWhy: rawA ? String(rawA.why || '').slice(0,300) : '', rawShort, from: memRef?key(memRef.member):(p?p.a:'coordinator'), seq: (seqRef && Number(seqRef.seq)) || head, post: jump ? Number(jump.target) : (p ? p.s : null), url: url?url.target:null }; });
    (Array.isArray(snap.systemAttention)?snap.systemAttention:[]).forEach(s=>{
      if(s && s.member && !isRole(s.member)){
        const rawWhy = String(s.text||s.detail||'').slice(0,200);
        const why = String(s.text_zh || s.detail_zh || tier1ClientFallback(rawWhy)).slice(0,200);
        const rawTitle = s.kind==='quota' ? `@${s.member} hit quota` : s.kind==='stuck' ? `@${s.member} looks stuck` : `@${s.member} hit an error`;
        const zhTitle = s.kind==='quota' ? `@${s.member} 额度已耗尽` : s.kind==='stuck' ? `@${s.member} 疑似停滞` : `@${s.member} 发生错误`;
        attention.push({id: String(s.id || `sys-${s.member}-${s.kind}`), kind: s.kind==='quota'?'quota':s.kind==='stuck'?'stuck':'error', severity:'high', title: zhTitle, why, short: null, rawTitle, rawWhy, from:key(s.member), seq:head});
      }
    });
    // Short copy the narrator writes next to each item (see swarm_narrator: `short`, `now`).
    (()=>{ const items=Object.create(null), members=Object.create(null);
      (Array.isArray(vj.attention)?vj.attention:[]).forEach(a=>{ const s=sh(a); if(s&&a.id){ const id=String(a.id); if(id!=='__proto__' && id!=='constructor' && id!=='prototype') items[id]=s; } });
      (Array.isArray(vj.workstreams)?vj.workstreams:[]).forEach(w=>{ const s=sh(w); if(s&&w.id){ const id=String(w.id); if(id!=='__proto__' && id!=='constructor' && id!=='prototype') items[id]=s; } });
      if(vj.now && typeof vj.now==='object') Object.entries(vj.now).forEach(([n,v])=>{ if(typeof v==='string' && n!=='__proto__' && n!=='constructor' && n!=='prototype') members[n===L?'coordinator':n]=trViewStr(v).slice(0,48); });
      window.SwarmHive = window.SwarmHive || {}; window.SwarmHive.viewCopy = {items, members, lead: members.coordinator?{doing:members.coordinator}:{} }; })();
    const askByFrom = new Map();
    const SEV = Object.assign(Object.create(null), {high:0, med:1, medium:1, low:2});
    attention.sort((a,b)=>(Object.hasOwn(SEV, a.severity) ? SEV[a.severity] : 2)-(Object.hasOwn(SEV, b.severity) ? SEV[b.severity] : 2));
    attention.filter(a=>a.kind!=='fyi' && !ISSUE_KINDS.has(a.kind) && a.from!=='coordinator').forEach(a=>{ if(!askByFrom.has(a.from)) askByFrom.set(a.from, a); });
    const issueByFrom = new Map();
    attention.filter(a=>ISSUE_KINDS.has(a.kind)).forEach(a=>{ if(!issueByFrom.has(a.from)) issueByFrom.set(a.from, a); });
    const needsYou = new Set(askByFrom.keys());
    const members = Object.create(null);
    team.forEach(m=>{ const n=key(m.name); const lp=lastPostBy(n);
      let status = m.killed ? 'parked' : (m.status==='working' ? 'working' : 'parked'); let waiting_on=null, waiting_seq=null;
      if(status==='parked' && !m.killed && lp && lp.to.length && !lp.to.includes('*') && /\?|could you|can you|please|ping me|waiting on/i.test(lp.x)){ const t=lp.to[0]; if(!P.some(q=>q.s>lp.s && q.a===t)){ status='waiting_on'; waiting_on=t; waiting_seq=lp.s; } }
      // A worker's ask goes to the coordinator, so the worker waits on it.
      if(needsYou.has(n) && !m.killed){ status='waiting_on'; waiting_on='coordinator'; waiting_seq=askByFrom.get(n).seq; }
      const rawPostNow = lp ? lp.x.replace(/^(\s*@[A-Za-z0-9_.-]+(?:\s*[,，:：、])?)+\s*/,'') : '';
      const rawNowBase = (m.status==='working' && m.activity) ? String(m.activity) : (lp ? rawPostNow : '暂无消息');
      const rawNowClean = cleanPath(rawNowBase).replace(/`([^`]+)`/g,'$1').slice(0,180);
      const zhNowBase = (m.status==='working' && m.activity)
        ? (m.activity_zh || tier1ClientFallback(m.activity))
        : (lp ? (lp.x_zh ? lp.x_zh.replace(/^(\s*@[A-Za-z0-9_.-]+(?:\s*[,，:：、])?)+\s*/,'') : tier1ClientFallback(rawPostNow)) : '暂无消息');
      const zhNowClean = cleanPath(zhNowBase).replace(/`([^`]+)`/g,'$1').slice(0,180);
      const now = zhNowClean;
      const liveZh = (m.status==='working' && m.activity) ? cleanPath(m.activity_zh || tier1ClientFallback(m.activity)).replace(/`([^`]+)`/g,'$1').slice(0,180) : '';
      const liveRaw = (m.status==='working' && m.activity) ? cleanPath(String(m.activity)).replace(/`([^`]+)`/g,'$1').slice(0,180) : '';
      const live = (m.status==='working' && !m.killed && !m.failure && m.activity && (status==='working' || n==='coordinator'))
        ? {text: liveZh, rawText: liveRaw, zhText: liveZh, kind: m.activityKind==='thinking' ? 'thinking' : 'tool'}
        : null;
      const ask = !m.killed ? (askByFrom.get(n) || null) : null;
      const issue = !m.killed ? (issueByFrom.get(n) || null) : null;
      const rawMemberTitle = (typeof m.title==='string' && m.title.trim()) ? String(m.title).trim().slice(0,120) : '';
      const rawMemberTitleZh = rawMemberTitle ? tier1ClientFallback(rawMemberTitle).slice(0,120) : '';
      const rawTaskTitle = rawMemberTitle
        || ((Object.hasOwn(planTasksRaw, m.name) && typeof planTasksRaw[m.name]==='string' && planTasksRaw[m.name].trim()) ? String(planTasksRaw[m.name]).trim().slice(0,120) : (briefOf(m.name, false) || ''));
      const zhBrief = briefOf(m.name, true);
      const zhTaskTitle = (typeof m.title_zh==='string' && m.title_zh.trim())
        ? String(m.title_zh).trim().slice(0,120)
        : ((Object.hasOwn(planTasks, m.name) && typeof planTasks[m.name]==='string' && planTasks[m.name].trim())
          ? trPlanStr(String(planTasks[m.name]).trim()).slice(0,120)
          : ((rawMemberTitleZh && rawMemberTitleZh !== rawMemberTitle)
            ? rawMemberTitleZh
            : (zhBrief
              ? (CJK_CHAR_RE.test(zhBrief) ? zhBrief : tier1ClientFallback(zhBrief).slice(0,120))
              : (rawTaskTitle ? tier1ClientFallback(rawTaskTitle).slice(0,120) : ''))));
      const failureTextRaw = m.failure && typeof m.failure.text === 'string' ? m.failure.text.trim().slice(0,200) : '';
      const failureTextZh = failureTextRaw ? String(m.failure_zh || tier1ClientFallback(failureTextRaw)).slice(0,200) : '';
      const failureInfo = m.failure && typeof m.failure === 'object'
        ? { kind: String(m.failure.kind || 'error'), text: failureTextZh || failureTextRaw, rawText: failureTextRaw, zhText: failureTextZh }
        : null;
      const title = n==='coordinator' ? '协调者' : zhTaskTitle;
      members[n] = { rawName:m.name, role:m.role, title, rawTitle: n==='coordinator' ? 'Coordinator' : rawTaskTitle, zhTitle: n==='coordinator' ? '协调者' : zhTaskTitle, model:m.model||'', status, waiting_on, waiting_seq, waiting_for:'', now, rawNow: lp || (m.status==='working' && m.activity) ? rawNowClean : '', zhNow: lp || (m.status==='working' && m.activity) ? zhNowClean : '', live, ask, issue, failure: failureInfo, steps:m.steps||0, posts:m.posts||0, killed:!!m.killed, last: lp?{seq:lp.s,time:lp.t,text:cleanPath(lp.x)}:null,
        owner: m.owner && m.owner.label ? {label:String(m.owner.label), kind:String(m.owner.kind||'')} : null, local: m.local!==false,
        last_seen: Number.isFinite(m.last_seen) ? m.last_seen : null, channels: Array.isArray(m.channels) ? m.channels.map(String) : [] }; });
    if(!members.coordinator) members.coordinator = { rawName:L, role:'coordinator', title:'协调者', rawTitle:'Coordinator', zhTitle:'协调者', model:'', status:'parked', now:'', rawNow:'', zhNow:'', ask:null, steps:0, posts:0, last:null };
    snap.members.filter(m=>m.roleWorker||m.narrator).forEach(m=>{ members['~'+m.name]={system:true, status:'parked', model:m.model||'', title:m.role||'role'}; });
    // Without a narrator view: killed, or parked after posting [done] (or after any post
    // once the coordinator closes the swarm with [done]), is done;
    // parked after an interim post is in review; waiting on a peer is blocked;
    // only a worker that has not started yet is up next.
    const isDonePost = lp => !!(lp && /^(@[A-Za-z0-9_-]+[\s,:–—-]*)*(?:\*\*|\*|`|_)?\[done\]/i.test(lp.x));
    const anyWorking = Object.values(members).some(x=>!x.system && x.status==='working');
    const lastP = P[P.length-1];
    const finished = !anyWorking && !attention.some(a=>a.kind!=='fyi') && !!lastP && lastP.a==='coordinator' && isDonePost(lastP);
    const STATES=['queued','active','blocked','review','done','failed'];
    const parseProg = (w)=>{
      if(w.progress && typeof w.progress==='object' && Number(w.progress.total)>0){
        const tot=Math.max(1,Number(w.progress.total)||1), dn=Math.max(0,Math.min(tot,Number(w.progress.done)||0));
        return {done:dn, total:tot, label:String(w.progress.label||(dn+'/'+tot)).slice(0,24)};
      }
      if(typeof w.progress==='number' && w.progress>=0 && w.progress<=100){
        const p=Math.round(w.progress); return {done:p, total:100, label:p+'%'};
      }
      const fm=/(?<!cl\/)(?<!\d\.)\b(\d{1,2})\s*(?:\/|of)\s*(\d{1,2})\b(?!\s*(?:AM|PM|am|pm))/.exec(String(w.note||''));
      if(fm){ const d=+fm[1], t=+fm[2]; if(t>=2 && t<=60 && d<=t) return {done:d, total:t, label:`${d}/${t}`}; }
      return null;
    };
    const rawWsById = new Map((Array.isArray(rawView?.workstreams)?rawView.workstreams:[]).filter(w=>w&&w.id).map(w=>[String(w.id), w]));
    let workstreams = (Array.isArray(vj.workstreams)?vj.workstreams:[]).filter(w=>w&&w.title).map((w,i)=>{ const seqs=(Array.isArray(w.refs)?w.refs:[]).map(r=>r&&r.seq).filter(Boolean); const rawState=STATES.includes(w.state)?w.state:'active';
      const rw = w.id ? rawWsById.get(String(w.id)) : null;
      return { id:w.id||('w'+i), title:trViewStr(w.title).slice(0,120), short: sh(w), owners:(Array.isArray(w.owners)?w.owners:[]).filter(o=>byName.has(o)&&!isRole(o)).map(key), state: rawState==='failed'?'blocked':rawState, rawState, progress:parseProg(w) || (rw ? parseProg(rw) : null), note:trViewStr(w.note||'').slice(0,200), seq: seqs.length?Math.max(...seqs):head }; });
    workstreams.forEach(w=>{ if(!w.owners.length) w.owners=['coordinator']; });
    const fallbackState = (x, lp) => x.killed ? 'done' : x.status==='waiting_on' ? 'blocked' :
        (x.status==='working' || x.status==='needs_you') ? 'active' : lp ? ((finished || isDonePost(lp)) ? 'done' : 'review') : 'queued';
    if(!workstreams.length) workstreams = team.filter(m=>m.role!=='coordinator').map(m=>{ const n=key(m.name); const lp=lastPostBy(n); const st=fallbackState(members[n], lp); return {id:n, title: members[n].title||'任务', short: null, owners:[n], state: st, rawState: st, blocked_on: members[n].waiting_on||null, note: members[n].now, seq: lp?lp.s:head}; });
    Object.entries(members).forEach(([n,x])=>{
      if(!x.system && n!=='coordinator' && !x.title){
        const ow = workstreams.filter(w=>w.owners.includes(n));
        if(ow.length) x.title = clipW(ow[ow.length-1].title, 7);
      }
      if(!x.system && n!=='coordinator' && !x.rawTitle){
        const rawWsList = Array.isArray(rawView?.workstreams) ? rawView.workstreams : [];
        const rawOw = rawWsList.filter(w=>w && Array.isArray(w.owners) && w.owners.some(o=>key(o)===n));
        if(rawOw.length && rawOw[rawOw.length-1].title) x.rawTitle = clipW(String(rawOw[rawOw.length-1].title), 7);
      }
    });
    const done = workstreams.filter(w=>w.state==='done').length;
    // Who each item waits on. The coordinator stopping for the user (its turn
    // ended on a reply with no worker still at work, or it failed or ran out of
    // quota) is the only 'you'.
    const coordReplied = !finished && !anyWorking && !!(leadM && !leadM.killed && leadM.status==='waiting' && leadM.replied);
    attention.forEach(a=>{ a.wait = a.kind==='fyi' ? null
      : (a.from==='coordinator' && String(a.id||'').startsWith('sys-')) ? 'you'
      : ISSUE_KINDS.has(a.kind) ? 'issue' : 'coordinator'; });
    if(coordReplied) attention.unshift({id:'sys-coordinator-reply', kind:'decision', severity:'high', title: '协调者正在等待你的回复', why: '请在协调者对话中回复。', short: null, rawTitle:'The coordinator is waiting for your reply', rawWhy:'Answer it in the coordinator chat.', from:'coordinator', seq:head, url:null, wait:'you'});
    const youItems = finished ? [] : attention.filter(a=>a.wait==='you');
    if(youItems.length && members.coordinator){ members.coordinator.status='needs_you'; members.coordinator.ask=youItems[0]; }
    const nowIso = new Date().toISOString();
    // Plan threads have no narrator line: use what the first working member in
    // the thread last said, clipped.
    const planNow = ids => { const x = ids.map(n=>Object.hasOwn(members, n) ? members[n] : null).find(m=>m && !m.killed && m.status==='working'); return x ? clipW(x.now, 8) : ''; };
    const trContainer = plan ? trPlanStr : trViewStr;
    const rawGoalTitle = narratorView ? (rawView?.goal?.title || '') : (rawPlan?.goal?.title || '');
    const lastPostSnippet = lastP ? (lastP.x_zh || tier1ClientFallback(lastP.x)) : '';
    return { title: snap.title_zh || tier1ClientFallback(snap.title) || snap.title || '未命名 Swarm',
      headline: vj.headline ? trViewStr(vj.headline).slice(0,220) : (plan && vj.goal && vj.goal.line) ? trPlanStr(vj.goal.line).slice(0,220) : (lastP ? `@${lastP.a}: ${lastPostSnippet.replace(/^(\s*@[A-Za-z0-9_.-]+(?:\s*[,，:：、])?)+\s*/,'').slice(0,140)}` : '等待首条消息。'),
      phase: vj.phase && vj.phase.label ? {label:trViewStr(vj.phase.label).slice(0,40), index:Number(vj.phase.index)||1, total:Number(vj.phase.total)||1} : {label: finished?'已完成':'进行中', index:1, total:1},
      done, total: workstreams.length||1, as_of: head, board_head: head, now: nowIso, started: P.length?P[0].t:nowIso, narrator_seq: Number(vj.as_of_seq)||head, finished,
      builtin: snap.builtinOverview === true,
      starting: snap.builtinOverview === true && !finished && !narratorView && !attention.length && !P.some(p=>p.a!=='coordinator'),
      latest: lastP?{agent:lastP.a,seq:lastP.s,time:lastP.t,text:lastP.x}:{agent:'coordinator',seq:0,time:nowIso,text:''},
      attention, workstreams, members,
      source: snap.source && typeof snap.source==='object' ? snap.source : null,
      // Progress reel (UI work only): frames the narrator picked; images come from /api/frame.
      reel: (()=>{ const useVjReel = !!(vj.reel && Array.isArray(vj.reel.frames) && vj.reel.frames.length);
        const fr = useVjReel ? vj.reel.frames : (Array.isArray(snap.frames) ? snap.frames : []);
        const rawFr = (useVjReel && rawView && rawView !== vj && rawView.reel && Array.isArray(rawView.reel.frames))
          ? rawView.reel.frames.filter(rf=>rf && typeof rf.path==='string' && rf.path.startsWith('/')).slice(0,40)
          : null;
        const conv=snap.conversationId||''; const tok=new URLSearchParams(location.search).get('token')||'';
        const frValid = fr.filter(f=>f && typeof f.path==='string' && f.path.startsWith('/')).slice(0,40);
        const out=frValid.map((f, i)=>{
          const fSeq = Number(f.seq)||0;
          let rawCap = '';
          if (rawFr) {
            const atI = rawFr[i];
            const rf = (atI && atI.path === f.path && (!fSeq || Number(atI.seq) === fSeq))
              ? atI
              : (rawFr.find(x => x.path === f.path && (!fSeq || Number(x.seq) === fSeq))
                || (fSeq ? rawFr.find(x => Number(x.seq) === fSeq) : null)
                || (rawFr.length === frValid.length ? atI : null));
            if (rf && typeof rf.caption === 'string') rawCap = rf.caption;
          }
          const curCap = String(f.caption||'');
          const capZh = f.caption_zh ? String(f.caption_zh) : tier1ClientFallback(curCap);
          const caption = capZh || curCap || rawCap;
          return { src:`/api/frame?conversationId=${encodeURIComponent(conv)}&path=${encodeURIComponent(f.path)}&seq=${fSeq}${tok?`&token=${encodeURIComponent(tok)}`:''}`, seq:fSeq, caption:caption.slice(0,160) };
        });
        return out.length>=2 ? out : null; })(),
      goal: vj.goal && typeof vj.goal==='object' && vj.goal.title ? {title:trContainer(vj.goal.title).slice(0,80), line:trContainer(vj.goal.line||'').slice(0,120)} : null,
      rawGoalTitle: String(rawGoalTitle).slice(0,80),
      fromPlan: !!plan,
      runningSummary: vj.running_summary ? trViewStr(vj.running_summary).slice(0,200) : '',
      threads: (Array.isArray(vj.threads)?vj.threads:[]).filter(t=>t&&t.title&&Array.isArray(t.workstreams)).slice(0,12).map(t=>({id:String(t.id||t.title).slice(0,48), title:trContainer(t.title).slice(0,40), goal:trContainer(t.goal||'').slice(0,100), now:String(t.now ? trContainer(t.now) : (plan ? planNow(t.workstreams) : '')).slice(0,80), state:String(t.state||''), workstreams:t.workstreams.map(String), attention:(Array.isArray(t.attention)?t.attention:[]).map(String)})),
    };
  }


  const ROOTS = new Map();   // container element -> {root, view, etag}
  function sync() { ROOTS.forEach((r, el) => { const tab = el.closest('.tab-body'); if (r.root.isConnected && (!tab || tab.classList.contains('active'))) render(r.root, r.view); }); }
  window.SwarmHive = Object.assign(window.SwarmHive || {}, {
    tier1Fallback: tier1ClientFallback,
    // Agent color shared with the Board avatars, so a name has one color everywhere.
    colorOf(n) { return tcol(n === (window.SwarmHive.leadName || 'coordinator') ? 'coordinator' : n); },
    // Board avatar: the member's bee on its tile color (the coordinator wears the crown).
    avatarHtml(name) {
      const n = name === (window.SwarmHive.leadName || 'coordinator') ? 'coordinator' : String(name || '?');
      return `<span class="msg-av bee" style="${hexBG(n)}" aria-hidden="true"><img src="${beeImg(n)}" alt="" width="22" height="18"></span>`;
    },
    // Render the swarm into `el` as `opts.view` ('overview' | 'cards').
    update(snap, el, opts) {
      if (!snap || !el) return;
      const view = (opts && opts.view) || 'overview';
      window.SwarmHive.embedded = true;
      let r = ROOTS.get(el);
      if (!r || !r.root.isConnected || r.root.parentNode !== el) {
        el.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'pane embedded';
        el.appendChild(root);
        r = {root, view};
        ROOTS.set(el, r);
      }
      if (snap.id !== S.swarm) {   // another swarm: drop filters, selections and open sections
        closeReel();
        for (const k of Object.keys(state)) delete state[k];
        state.view = 'overview';
        S.swarm = snap.id;
        S.etag = '';
        ROOTS.forEach((x) => { x.etag = ''; });
      }
      if (r.etag && r.etag === snap.etag && r.view === view && !(opts && opts.force)) return;   // unchanged: keep animations running
      r.view = view;
      const tab = el.closest('.tab-body');
      if (tab && !tab.classList.contains('active')) return;   // hidden: render when its tab opens
      try {
        const prevSnap = S.snap;
        const locChanged = !prevSnap ||
          Boolean(prevSnap._viewLocalized) !== Boolean(snap._viewLocalized) ||
          Boolean(prevSnap._planLocalized) !== Boolean(snap._planLocalized);
        S.snap = snap;
        if (!S.live || S.etag !== snap.etag || locChanged || (opts && opts.force)) {
          S.live = toModel(snap);
          S.etag = snap.etag;
        }
        r.etag = snap.etag;
        render(r.root, view);
      } catch (e) { console.warn('SwarmHive', e); }
    },
  });
})();
