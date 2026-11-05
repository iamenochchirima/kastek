// Standalone widget code uses DOM nodes rather than interpreting message text as HTML.
export const websiteMarkdownScript = String.raw`
  function renderMarkdown(source){
    const text=String(source),maxNodes=4000;let nodes=0;
    const node=tag=>{if(++nodes>maxNodes)throw new Error('Markdown limit');return document.createElement(tag)};
    function inline(parent,value,depth=0){
      if(depth>8){parent.append(document.createTextNode(value));return;}
      let plain='';const flush=()=>{if(plain){parent.append(document.createTextNode(plain));plain=''}};
      for(let i=0;i<value.length;){
        if(value.charCodeAt(i)===92&&i+1<value.length&&('*_[]{}()#+.!>~-|'.includes(value[i+1])||[92,96].includes(value.charCodeAt(i+1)))){plain+=value[i+1];i+=2;continue;}
        if(value[i]==='\x60'){
          let width=1;while(value[i+width]==='\x60')width++;
          const end=value.indexOf('\x60'.repeat(width),i+width);
          if(end>=0){flush();const code=node('code');code.textContent=value.slice(i+width,end).replace(/\n/g,' ');parent.append(code);i=end+width;continue;}
        }
        if(value[i]==='['&&value[i-1]!=='!'){
          const close=value.indexOf('](',i+1);
          if(close>=0){let end=close+2,balance=1;for(;end<value.length&&balance;end++){if(value[end]==='(')balance++;else if(value[end]===')')balance--;}
            if(!balance){const raw=value.slice(close+2,end-1).trim();let url;try{url=new URL(raw)}catch{}
              if(url&&['http:','https:'].includes(url.protocol)){flush();const link=node('a');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';inline(link,value.slice(i+1,close),depth+1);parent.append(link);i=end;continue;}
            }
          }
        }
        const marker=value.startsWith('**',i)?'**':value.startsWith('__',i)?'__':value[i]==='*'?'*':value[i]==='_'&&!/[\p{L}\p{N}]/u.test(value[i-1]||'')?'_':null;
        if(marker){let end=value.indexOf(marker,i+marker.length);if(marker.length===2&&value[end+2]===marker[0]&&value.slice(i+2,end).includes(marker[0]))end++;if(end>i+marker.length){flush();const emphasis=node(marker.length===2?'strong':'em');inline(emphasis,value.slice(i+marker.length,end),depth+1);parent.append(emphasis);i=end+marker.length;continue;}}
        if(value[i]==='\n'){flush();parent.append(node('br'));i++;continue;}
        plain+=value[i++];
      }
      flush();
    }
    const listMatch=line=>/^ {0,3}([-+*]|\d+[.)])\s+(.*)$/.exec(line);
    const fenceMatch=line=>/^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    function tableCells(line){
      const cells=[];let value='',codeWidth=0;
      for(let i=0;i<line.length;){
        if(line.charCodeAt(i)===92&&i+1<line.length){value+=line.slice(i,i+2);i+=2;continue;}
        if(line.charCodeAt(i)===96){let width=1;while(line.charCodeAt(i+width)===96)width++;if(!codeWidth)codeWidth=width;else if(codeWidth===width)codeWidth=0;value+=line.slice(i,i+width);i+=width;continue;}
        if(line[i]==='|'&&!codeWidth){cells.push(value.trim());value='';i++;continue;}
        value+=line[i++];
      }
      cells.push(value.trim());if(cells.length>1&&!cells[0])cells.shift();if(cells.length>1&&!cells[cells.length-1])cells.pop();return cells;
    }
    function tableHeader(lines,index){
      if(index+1>=lines.length||!lines[index].includes('|'))return null;
      const headers=tableCells(lines[index]),separators=tableCells(lines[index+1]);
      return headers.length===separators.length&&separators.every(cell=>/^:?-{3,}:?$/.test(cell))?{headers,alignments:separators.map(cell=>cell.startsWith(':')?(cell.endsWith(':')?'center':'left'):cell.endsWith(':')?'right':null)}:null;
    }
    const startsBlock=line=>/^ {0,3}#{1,6}\s+/.test(line)||!!listMatch(line)||!!fenceMatch(line)||/^ {0,3}>/.test(line)||/^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/.test(line);
    function blocks(parent,value,depth=0){
      if(depth>8){parent.append(document.createTextNode(value));return;}
      const lines=value.replace(/\r\n?/g,'\n').split('\n');let i=0;
      while(i<lines.length){
        if(!lines[i].trim()){i++;continue;}
        const fence=fenceMatch(lines[i]);
        if(fence){const content=[];i++;while(i<lines.length&&!new RegExp('^ {0,3}'+fence[1][0]+'{'+fence[1].length+',}\s*$').test(lines[i]))content.push(lines[i++]);if(i<lines.length)i++;const pre=node('pre'),code=node('code');code.textContent=content.join('\n');pre.append(code);parent.append(pre);continue;}
        const heading=/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(lines[i]);
        if(heading){const title=node('h'+heading[1].length);inline(title,heading[2]);parent.append(title);i++;continue;}
        if(/^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/.test(lines[i])){parent.append(node('hr'));i++;continue;}
        if(/^ {0,3}>/.test(lines[i])){const quoted=[];while(i<lines.length&&/^ {0,3}>/.test(lines[i]))quoted.push(lines[i++].replace(/^ {0,3}> ?/,''));const quote=node('blockquote');blocks(quote,quoted.join('\n'),depth+1);parent.append(quote);continue;}
        const header=tableHeader(lines,i);
        if(header){
          const wrap=node('div'),table=node('table'),head=node('thead'),row=node('tr'),body=node('tbody');wrap.className='markdown-table';wrap.setAttribute('role','region');wrap.setAttribute('aria-label','Table');wrap.tabIndex=0;
          const appendRow=(target,values,heading=false)=>{const tr=heading?row:node('tr');for(let column=0;column<header.headers.length;column++){const cell=node(heading?'th':'td');if(heading)cell.scope='col';if(header.alignments[column])cell.style.textAlign=header.alignments[column];inline(cell,values[column]||'');tr.append(cell);}target.append(tr)};
          appendRow(head,header.headers,true);i+=2;
          while(i<lines.length&&lines[i].trim()&&lines[i].includes('|')&&!startsBlock(lines[i])){appendRow(body,tableCells(lines[i++]));}
          table.append(head,body);wrap.append(table);parent.append(wrap);continue;
        }
        const first=listMatch(lines[i]);
        if(first){const ordered=/^\d/.test(first[1]),list=node(ordered?'ol':'ul');if(ordered&&parseInt(first[1],10)!==1)list.start=parseInt(first[1],10);
          while(i<lines.length){const item=listMatch(lines[i]);if(!item||/^\d/.test(item[1])!==ordered)break;const content=[item[2]];i++;while(i<lines.length&&/^ {2,}\S/.test(lines[i]))content.push(lines[i++].replace(/^ {2,4}/,''));const li=node('li');blocks(li,content.join('\n'),depth+1);list.append(li);}
          parent.append(list);continue;
        }
        const content=[lines[i++]];while(i<lines.length&&lines[i].trim()&&!startsBlock(lines[i])&&!tableHeader(lines,i))content.push(lines[i++]);const paragraph=node('p');inline(paragraph,content.join('\n'));parent.append(paragraph);
      }
    }
    const fragment=document.createDocumentFragment();
    if(text.length>65536){fragment.append(document.createTextNode(text));return fragment;}
    try{blocks(fragment,text);return fragment}catch{const fallback=document.createDocumentFragment();fallback.append(document.createTextNode(text));return fallback;}
  }
`;
