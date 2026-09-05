"""Desktop UI for the stable market_data_api interface."""
from __future__ import annotations

import queue
import threading
import tkinter as tk
from datetime import date
from tkinter import messagebox, ttk

from market_data_api import MarketDataError, get_status, update_data


class MarketDataUI(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Market Data Factory")
        self.geometry("900x650")
        self.minsize(760, 540)
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.cancel_event = threading.Event()
        self.worker: threading.Thread | None = None

        self.data_type = tk.StringVar(value="daily")
        self.mode = tk.StringVar(value="incremental")
        self.start_date = tk.StringVar(value="2025-03-04")
        self.end_date = tk.StringVar(value=date.today().isoformat())
        self.status_text = tk.StringVar(value="대기 중")
        self.progress_text = tk.StringVar(value="0 / 0")

        self._build()
        self.mode.trace_add("write", lambda *_: self._sync_mode())
        self._sync_mode()
        self.after(100, self._drain_events)
        self.protocol("WM_DELETE_WINDOW", self._close)

    def _build(self) -> None:
        outer = ttk.Frame(self, padding=16)
        outer.pack(fill="both", expand=True)

        controls = ttk.LabelFrame(outer, text="업데이트 설정", padding=12)
        controls.pack(fill="x")

        ttk.Label(controls, text="데이터").grid(row=0, column=0, sticky="w", padx=(0, 12), pady=6)
        ttk.Radiobutton(controls, text="일봉", variable=self.data_type, value="daily").grid(row=0, column=1, sticky="w")
        ttk.Radiobutton(controls, text="분봉", variable=self.data_type, value="minute").grid(row=0, column=2, sticky="w")
        ttk.Radiobutton(controls, text="시가총액", variable=self.data_type, value="market_cap").grid(row=0, column=3, sticky="w")
        ttk.Radiobutton(controls, text="시장지수", variable=self.data_type, value="market_index").grid(row=0, column=4, sticky="w")

        ttk.Label(controls, text="방식").grid(row=1, column=0, sticky="w", padx=(0, 12), pady=6)
        ttk.Radiobutton(controls, text="마지막 일자 이후", variable=self.mode, value="incremental").grid(row=1, column=1, sticky="w")
        ttk.Radiobutton(controls, text="선택 기간 전체 갱신", variable=self.mode, value="full").grid(row=1, column=2, sticky="w")

        ttk.Label(controls, text="시작일").grid(row=2, column=0, sticky="w", padx=(0, 12), pady=6)
        self.start_entry = ttk.Entry(controls, textvariable=self.start_date, width=16)
        self.start_entry.grid(row=2, column=1, sticky="w")
        ttk.Label(controls, text="종료일").grid(row=2, column=2, sticky="e", padx=(24, 8))
        ttk.Entry(controls, textvariable=self.end_date, width=16).grid(row=2, column=3, sticky="w")
        ttk.Label(controls, text="YYYY-MM-DD").grid(row=2, column=4, sticky="w", padx=8)

        buttons = ttk.Frame(outer, padding=(0, 12))
        buttons.pack(fill="x")
        self.run_button = ttk.Button(buttons, text="업데이트 실행", command=self._start_update)
        self.run_button.pack(side="left")
        self.daily_status_button = ttk.Button(buttons, text="선택 데이터 상태", command=lambda: self._start_status(self.data_type.get()))
        self.daily_status_button.pack(side="left", padx=(8, 0))
        self.stop_button = ttk.Button(buttons, text="중지", command=self._cancel, state="disabled")
        self.stop_button.pack(side="right")

        ttk.Label(outer, textvariable=self.status_text).pack(anchor="w", pady=(2, 4))
        self.progress = ttk.Progressbar(outer, maximum=100, mode="determinate")
        self.progress.pack(fill="x")
        ttk.Label(outer, textvariable=self.progress_text).pack(anchor="e", pady=(3, 8))

        log_frame = ttk.LabelFrame(outer, text="실행 로그", padding=8)
        log_frame.pack(fill="both", expand=True)
        self.log = tk.Text(log_frame, wrap="none", state="disabled", font=("Consolas", 10))
        y_scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log.yview)
        self.log.configure(yscrollcommand=y_scroll.set)
        self.log.pack(side="left", fill="both", expand=True)
        y_scroll.pack(side="right", fill="y")

    def _sync_mode(self) -> None:
        self.start_entry.configure(state="normal" if self.mode.get() == "full" else "disabled")

    def _set_running(self, running: bool) -> None:
        state = "disabled" if running else "normal"
        self.run_button.configure(state=state)
        self.daily_status_button.configure(state=state)
        self.stop_button.configure(state="normal" if running else "disabled")

    def _append_log(self, text: str) -> None:
        self.log.configure(state="normal")
        self.log.insert("end", text.rstrip() + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _validate_date(self, value: str, label: str) -> bool:
        try:
            date.fromisoformat(value)
            return True
        except ValueError:
            messagebox.showerror("날짜 오류", f"{label}은 YYYY-MM-DD 형식이어야 합니다.")
            return False

    def _start_update(self) -> None:
        if not self._validate_date(self.end_date.get(), "종료일"):
            return
        if self.mode.get() == "full" and not self._validate_date(self.start_date.get(), "시작일"):
            return
        if self.mode.get() == "full" and self.start_date.get() > self.end_date.get():
            messagebox.showerror("기간 오류", "시작일은 종료일보다 늦을 수 없습니다.")
            return
        self.cancel_event.clear()
        self.progress["value"] = 0
        self.progress_text.set("계획 계산 중")
        self.status_text.set("업데이트를 시작합니다.")
        self._set_running(True)

        def work() -> None:
            try:
                result = update_data(
                    self.data_type.get(), self.mode.get(),
                    self.start_date.get() if self.mode.get() == "full" else None,
                    self.end_date.get(), self._progress_callback,
                    cancel_event=self.cancel_event,
                )
                self.events.put(("finished", result))
            except Exception as exc:
                self.events.put(("failed", exc))

        self.worker = threading.Thread(target=work, daemon=True)
        self.worker.start()

    def _start_status(self, data_type: str) -> None:
        self.cancel_event.clear()
        self.status_text.set(f"{data_type} 상태를 확인합니다.")
        self._set_running(True)

        def work() -> None:
            try:
                self.events.put(("status", get_status(data_type, self._progress_callback)))
            except Exception as exc:
                self.events.put(("failed", exc))

        self.worker = threading.Thread(target=work, daemon=True)
        self.worker.start()

    def _progress_callback(self, event: dict[str, object]) -> None:
        self.events.put(("progress", event))

    def _cancel(self) -> None:
        self.cancel_event.set()
        self.status_text.set("중지 요청을 전달했습니다…")
        self.stop_button.configure(state="disabled")

    def _close(self) -> None:
        if self.worker and self.worker.is_alive():
            if not messagebox.askyesno("종료 확인", "실행 중인 작업을 중지하고 창을 닫을까요?"):
                return
            self.cancel_event.set()
        self.destroy()

    def _handle_progress(self, event: dict[str, object]) -> None:
        name = str(event.get("event", ""))
        self._append_log(str(event))
        if name == "progress":
            percent = float(event.get("percent", 0))
            self.progress["value"] = percent
            self.progress_text.set(f'{event.get("completed", 0)} / {event.get("total", 0)} ({percent:.1f}%)')
            code = event.get("code")
            self.status_text.set(f'{event.get("type", "")} {code or ""} {event.get("status", "처리 중")}'.strip())
        elif name == "collector_progress":
            self.status_text.set(
                f'{event.get("type", "")} {event.get("code", "")} '
                f'{event.get("completed", 0)}/{event.get("total", 0)} {event.get("status", "처리 중")}'
            )
        elif name == "plan":
            self.progress_text.set(f'대상 {event.get("updateNeeded", 0)} / 전체 {event.get("universe", 0)}')
            self.status_text.set("업데이트 계획을 계산했습니다.")
        elif name == "batch_start":
            self.status_text.set(f'{event.get("type")} 다운로드 {event.get("from")} ~ {event.get("end")}')
        elif name == "import_start":
            self.status_text.set(f'DB 적재 중: {event.get("files", 0)}개 종목')
        elif name == "error":
            self.status_text.set(str(event.get("message", "오류")))
        elif name == "complete":
            self.progress["value"] = 100
            self.progress_text.set("완료")
            self.status_text.set(str(event.get("message", "업데이트 완료")))
        elif name == "status":
            self.progress_text.set("상태 확인 완료")
            self.status_text.set(str(event.get("message", "상태 확인 완료")))
        elif name == "log":
            self.status_text.set(str(event.get("message", "실행 중"))[-120:])

    def _drain_events(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "progress":
                    self._handle_progress(payload)  # type: ignore[arg-type]
                elif kind == "status":
                    self._append_log(str(payload))
                    self.status_text.set("상태 확인 완료")
                    self._set_running(False)
                elif kind == "finished":
                    self.progress["value"] = 100
                    self.progress_text.set("완료")
                    self.status_text.set("업데이트 완료")
                    self._set_running(False)
                elif kind == "failed":
                    self.status_text.set("중지됨" if self.cancel_event.is_set() else "실행 실패")
                    self._append_log(f"ERROR: {payload}")
                    self._set_running(False)
                    if not self.cancel_event.is_set():
                        messagebox.showerror("실행 실패", str(payload))
        except queue.Empty:
            pass
        self.after(100, self._drain_events)


if __name__ == "__main__":
    MarketDataUI().mainloop()
