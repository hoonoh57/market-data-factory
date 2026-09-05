# Python UI 일봉·분봉 호출 규격

## 기본 UI 실행

저장소 루트의 `RUN_MARKET_DATA_UI.bat`를 더블클릭한다.

```powershell
E:\market-data-factory\RUN_MARKET_DATA_UI.bat
```

화면에서 일봉/분봉/시가총액/시장지수, 전체 갱신/추가 업데이트, 시작일/종료일을 선택할 수 있다. 모든 외부 수집은 market-data-factory가 수행하고 MySQL에 저장한다. 상태 버튼과 중지 버튼, 종목별 진행률 및 실시간 로그가 제공된다.

64비트 Python UI는 저장소 루트의 `market_data_api.py`만 호출한다. UI에서 Node, npm, 32비트 Python 또는 개별 collector/importer를 직접 호출하지 않는다.

## 공개 함수

```python
from market_data_api import get_status, update_bars
```

### 전체 기간 재다운로드

기존 DB 행을 삭제하지 않는다. 선택 기간을 모든 `market_instrument.instrument_type='EQUITY'` 종목에 대해 다시 받아 upsert한다. 기간 내부 누락 복구에 사용한다.

```python
update_bars(
    data_type="minute",
    mode="full",
    start_date="2026-08-20",
    end_date="2026-08-31",
    progress_callback=on_progress,
)
```

### 마지막 일자 이후 추가 업데이트

각 종목의 DB `MAX(trading_date) + 1일`부터 이어받는다. 분봉이 전혀 없는 종목은 분봉 테이블 전체의 최초 보유일부터 받는다.

```python
update_bars(
    data_type="daily",
    mode="incremental",
    end_date="2026-09-01",
    progress_callback=on_progress,
)
```

### 상태 확인

```python
daily = get_status("daily")
minute = get_status("minute")
```

결과에는 `universe`, `instrumentsWithData`, `missingInstruments`, `earliestDate`, `latestDate`가 포함된다. 대용량 분봉 상태 버튼에서는 전체 행 수 스캔을 수행하지 않는다.

## UI 버튼 연결 예

```python
def on_progress(event):
    if event["event"] == "progress":
        progress_bar.setValue(int(event["percent"]))
        status_label.setText(f'{event["completed"]}/{event["total"]}')
    elif event["event"] in ("batch_start", "import_start", "complete", "error"):
        status_label.setText(str(event))

# 콤보박스 값: daily 또는 minute
# 모드 값: full 또는 incremental
update_bars(selected_type, selected_mode, start_date, end_date, on_progress)
```

GUI가 멈추지 않도록 `update_bars`는 UI 메인 스레드가 아닌 worker thread에서 호출한다. 사용자가 취소할 수 있게 하려면 worker/process 종료 기능을 UI에 연결한다.

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
