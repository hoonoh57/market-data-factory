# Python UI 일봉·분봉 호출 규격

> 현재 실제 updater 구조와 2026-09-06 일봉 장애 교정 내용은
> [`CURRENT_UPDATE_PIPELINE.md`](CURRENT_UPDATE_PIPELINE.md)를 함께 읽는다.

## 기본 UI 실행

저장소 루트의 `RUN_MARKET_DATA_UI.bat`를 더블클릭한다.

```powershell
E:\market-data-factory\RUN_MARKET_DATA_UI.bat
```

화면에서 일봉/분봉/시가총액/시장지수, 전체 갱신/추가 업데이트, 시작일/종료일을 선택할 수 있다. 모든 외부 수집은 market-data-factory가 수행하고 MySQL에 저장한다. 상태 버튼과 중지 버튼, 종목별 진행률 및 실시간 로그가 제공된다.

64비트 Python UI는 저장소 루트의 `market_data_api.py`만 호출한다. UI에서 Node, npm, 32비트 Python 또는 개별 collector/importer를 직접 호출하지 않는다.

현재 호출 경로:

```text
RUN_MARKET_DATA_UI.bat
  -> market_data_ui.py
  -> market_data_api.py
  -> daily/minute: scripts/update-korean-equity-bars.mjs
  -> 32-bit CYBOS collector
  -> staging CSV
  -> Node importer
  -> MySQL
  -> BAR_EVENT/status
```

시가총액과 시장지수는 `market_data_api.py`가 각 전용 updater로 라우팅한다.

## 공개 함수

```python
from market_data_api import get_status, update_bars
```

`update_data`는 현재 `update_bars`의 별칭이다.

## 대상 universe

일봉/분봉 shared updater는 MySQL `market_instrument`의 다음 행을 대상으로 한다.

```sql
instrument_type = 'EQUITY'
```

정규화된 종목코드는 `[0-9A-Z]{6}`을 허용한다. 숫자 6자리뿐 아니라 `0001A0` 같은 영숫자 6자리도 정상 종목코드로 취급한다.

## 전체 기간 재다운로드

기존 DB 행을 삭제하지 않는다. 선택 기간을 모든 EQUITY 종목에 대해 다시 받아 upsert한다. 기간 내부 누락 복구에 사용한다.

```python
update_bars(
    data_type="minute",
    mode="full",
    start_date="2026-08-20",
    end_date="2026-08-31",
    progress_callback=on_progress,
)
```

## 마지막 일자 이후 추가 업데이트

각 종목의 DB `MAX(trading_date) + 1일`부터 이어받는다.

```python
update_bars(
    data_type="daily",
    mode="incremental",
    end_date="2026-09-01",
    progress_callback=on_progress,
)
```

해당 종목에 기존 데이터가 전혀 없을 때의 fallback은 dataset별로 다르다.

- daily: 전체 daily 테이블의 최초 보유일부터 시작하며, daily 테이블 자체가 비어 있으면 `2021-01-01`
- minute: 전체 minute 테이블의 최초 보유일부터 시작
- minute 테이블 자체가 비어 있으면 최초 수집에는 명시적 start date가 필요

따라서 일반 UI incremental은 현재 보유 coverage를 이어가는 기능이다. 별도의 장기 전종목 분봉 backfill과 같은 의미가 아니다.

## 기본 end date 규칙

명시적인 `end_date`가 없을 때 shared updater는 KST 기준으로:

- 20:00 이전: 전일 calendar date
- 20:00 이후: 당일 calendar date

를 요청 상한으로 사용한다.

실제 거래일 존재 여부는 provider 응답으로 결정된다. 주말/휴일을 종료일로 요청해도 실제 `target_end`는 마지막 거래일이 될 수 있다.

## 일봉 production contract

UI에서 호출하는 canonical daily dataset은 다음 계약을 유지한다.

```text
provider     = CpSysDib.StockChart
request mode = 기간조회
period       = D
exchange     = A
adjusted     = true
fields       = date/open/high/low/close/volume/amount
```

`A`는 production에서 KRX+NXT 통합 일봉을 의미한다. 오류 회피를 위해 `K`로 바꾸지 않는다.

### 휴일 종료일 exact duplicate

CYBOS 기간조회 종료일이 휴일/주말일 때 마지막 거래일을 동일 값으로 두 번 반환하는 사례가 실측됐다.

현재 daily collector는:

- 날짜와 모든 OHLCV/amount가 동일하면 exact duplicate 하나만 제거
- 같은 날짜인데 값이 다르면 `DUPLICATE_DATE_DRIFT`로 실패
- drift를 transport retry로 바꾸지 않음

으로 처리한다.

### provider-invalid 종목

CYBOS `유효하지 않은 종목코드입니다.`는 재시도로 복구되지 않는 permanent symbol error로 분류한다.

- 해당 종목만 `invalid`로 진행 이벤트를 남기고 계속 진행
- transport/data-validation 오류는 기존처럼 fatal/error 경로 유지

## 분봉 production contract

```text
provider     = CpSysDib.StockChart
interval     = exact 1 minute
exchange     = A
adjusted     = true
timestamp    = Korea market wall-clock DATETIME
```

정상 shared updater는 모든 EQUITY를 대상으로 per-symbol latest date 이후를 이어받는다.

장기 전종목 역사 backfill은 별도 명령이다.

```powershell
npm run data:minute:backfill-all
```

이 explicit backfill을 routine UI incremental 동작에 암묵적으로 합치지 않는다.

## 상태 확인

```python
daily = get_status("daily")
minute = get_status("minute")
```

결과에는 `universe`, `instrumentsWithData`, `missingInstruments`, `earliestDate`, `latestDate`가 포함된다. 대용량 분봉 상태 버튼에서는 전체 행 수 스캔을 수행하지 않는다.

해석 주의:

- `missingInstruments` = 해당 dataset에 한 행도 없는 EQUITY 수
- `missingInstruments=0` = 모든 종목이 최신이라는 뜻이 아님
- `latestDate` = dataset 전체의 global max date

모든 종목이 global `latestDate`까지 최신인지 확인하려면 별도 per-symbol coverage audit가 필요하다.

## UI 버튼 연결 예

```python
def on_progress(event):
    if event["event"] == "progress":
        progress_bar.setValue(int(event["percent"]))
        status_label.setText(f'{event["completed"]}/{event["total"]}')
    elif event["event"] in ("batch_start", "import_start", "complete", "error"):
        status_label.setText(str(event))

update_bars(selected_type, selected_mode, start_date, end_date, on_progress)
```

GUI가 멈추지 않도록 `update_bars`는 UI 메인 스레드가 아닌 worker thread에서 호출한다. 사용자가 취소할 수 있게 하려면 worker/process 종료 기능을 UI에 연결한다. 현재 `market_data_ui.py`는 worker thread와 cancel event를 사용한다.

## CLI 점검

실제 다운로드 없이 계획만 확인:

```powershell
npm run bars:update -- --type minute --mode full --start 2026-08-20 --end 2026-08-31 --dry-run
```

상태 확인:

```powershell
npm run bars:status -- --type daily
npm run bars:status -- --type minute
```

모든 진행 이벤트는 한 줄 JSON인 `BAR_EVENT {...}` 형식으로 즉시 출력된다.

일봉 collector에는 현재 일부 `collector_progress` 이벤트가 두 번 출력되는 instrumentation bug가 남아 있다. 이 현상은 시장 데이터 중복과 별개이며, data-source/importer 수정과 분리해서 교정한다.

## 시가총액 최초 설정

KRX 정보데이터시스템 로그인 ID/PW는 사용하지 않는다. KRX Open API에서 인증키를 발급받고
`주식 > 유가증권 일별매매정보`, `주식 > 코스닥 일별매매정보` 서비스를 신청·승인받은 뒤
`E:\market-data-factory\.env`에 아래 한 항목을 추가한다.

```dotenv
KRX_AUTH_KEY=<발급받은 인증키>
```

수집기는 인증키를 HTTP `AUTH_KEY` 헤더로만 전달하며 화면이나 로그에 출력하지 않는다.
Python 외부 패키지와 `pykrx`는 사용하지 않는다. Quant의 `.env`나 수집 코드도 참조하지 않는다.

시가총액은 코스피·코스닥 전 종목의 월말(휴장일이면 직전 거래일) 스냅샷을 수집한다.
추가 업데이트는 DB의 마지막 스냅샷이 속한 달부터 다시 조회하여 진행 중인 달도 upsert한다.

## Storage rule

MySQL이 durable SSOT다. `.runtime` CSV는 staging transport일 뿐이다.

현재 active UI/update path에는 Parquet cache가 없다. 향후 조건검색 가속용 Parquet를 복원하더라도 MySQL에서 재생성 가능한 derived cache로 유지하고, updater의 필수 저장소나 두 번째 SSOT로 만들지 않는다.
