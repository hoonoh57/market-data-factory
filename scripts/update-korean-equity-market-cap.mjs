import { readFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createMySqlPool } from '../src/db/mysql.mjs';
const arg=n=>{const i=process.argv.indexOf(`--${n}`);return i<0?null:process.argv[i+1]};
const emit=(event,x={})=>console.log(`BAR_EVENT ${JSON.stringify({event,type:'market_cap',...x})}`);
const run=(c,a)=>new Promise((ok,no)=>{const p=spawn(c,a,{stdio:'inherit',shell:false,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});p.on('error',no);p.on('exit',x=>x===0?ok():no(new Error(`${c} exited ${x}`)))});
const pool=createMySqlPool();
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS korean_equity_market_cap (instrument_id BIGINT UNSIGNED NOT NULL,trading_date DATE NOT NULL,listed_shares BIGINT UNSIGNED NOT NULL,market_cap BIGINT UNSIGNED NOT NULL,source_provider VARCHAR(32) NOT NULL DEFAULT 'KRX',source_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,PRIMARY KEY(instrument_id,trading_date),KEY idx_korean_equity_market_cap_date(trading_date,instrument_id),CONSTRAINT fk_korean_equity_market_cap_instrument FOREIGN KEY(instrument_id) REFERENCES market_instrument(instrument_id)) ENGINE=InnoDB`);
  if(arg('command')==='status') { const [[r]]=await pool.query(`SELECT COUNT(*) rows_count,COUNT(DISTINCT instrument_id) instruments,DATE_FORMAT(MIN(trading_date),'%Y-%m-%d') earliest_date,DATE_FORMAT(MAX(trading_date),'%Y-%m-%d') latest_date FROM korean_equity_market_cap`); emit('status',r); process.exitCode=0; }
  else {
    if (!process.env.KRX_AUTH_KEY) throw new Error('KRX_AUTH_KEY가 없습니다. E:\\market-data-factory\\.env에 공식 KRX Open API 인증키를 설정하고 주식 API 활용 승인을 확인하세요.');
    const mode=arg('mode')||'incremental', end=arg('end')||new Date().toISOString().slice(0,10); let start=arg('start');
    if(mode==='incremental'){const [[r]]=await pool.query(`SELECT DATE_FORMAT(MAX(trading_date),'%Y-%m-%d') d FROM korean_equity_market_cap`);start=start||r.d||'2021-01-01';}
    if(!start) throw new Error('--start required for full mode');
    const dir=path.resolve('.runtime/market-cap'); await rm(dir,{recursive:true,force:true});await mkdir(dir,{recursive:true});const csv=path.join(dir,'market-cap.csv');
    emit('plan',{mode,start,end}); await run(process.env.MARKET_DATA_PYTHON64||'python',[path.resolve('addons/korean-equity-market-cap/collector/krx_market_cap.py'),'--from',start,'--to',end,'--output',csv]);
    const lines=(await readFile(csv,'utf8')).trim().split(/\r?\n/).slice(1);let done=0;
    for(let i=0;i<lines.length;i+=500){
      const chunk=lines.slice(i,i+500).map(x=>x.split(','));
      const selects=chunk.map(()=>`SELECT ? code,? trading_date,? listed_shares,? market_cap`).join(' UNION ALL '), values=chunk.flatMap(([code,d,shares,cap])=>[code,d,shares,cap]);
      await pool.query(`INSERT INTO korean_equity_market_cap(instrument_id,trading_date,listed_shares,market_cap,source_provider) SELECT i.instrument_id,x.trading_date,x.listed_shares,x.market_cap,'KRX' FROM (${selects}) x JOIN market_instrument i ON i.code=x.code ON DUPLICATE KEY UPDATE listed_shares=VALUES(listed_shares),market_cap=VALUES(market_cap),source_provider='KRX'`,values);
      done+=chunk.length;emit('progress',{completed:done,total:lines.length,percent:+(done*100/lines.length).toFixed(1)});
    }
    emit('complete',{rows:done});
  }
} catch(e){emit('error',{message:e.message});process.exitCode=1} finally {await pool.end()}
