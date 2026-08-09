import json
import os
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.environ.get("COMPILER_SERVICE_SECRET", "")


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.send_json(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self):
        if self.path != "/compile":
            return self.send_json(404, {"error": "Not found."})
        if not SECRET or self.headers.get("Authorization") != f"Bearer {SECRET}":
            return self.send_json(401, {"error": "Unauthorized."})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 2 or size > 200_000:
                return self.send_json(413, {"error": "Invalid firmware payload size."})
            body = json.loads(self.rfile.read(size))
            ini, source = body.get("platformioIni"), body.get("mainCpp")
            if not isinstance(ini, str) or not isinstance(source, str):
                return self.send_json(400, {"error": "Firmware files are required."})
            directory = tempfile.mkdtemp(prefix="blueprint-")
            try:
                os.makedirs(os.path.join(directory, "src"))
                with open(os.path.join(directory, "platformio.ini"), "w", encoding="utf-8") as file:
                    file.write(ini)
                with open(os.path.join(directory, "src", "main.cpp"), "w", encoding="utf-8") as file:
                    file.write(source)
                result = subprocess.run(["pio", "run", "--project-dir", directory], capture_output=True, text=True, timeout=210)
                details = (result.stdout + "\n" + result.stderr)[-8000:]
                self.send_json(200 if result.returncode == 0 else 422, {"ok": result.returncode == 0, "error": None if result.returncode == 0 else "Firmware did not compile.", "details": details})
            finally:
                shutil.rmtree(directory, ignore_errors=True)
        except subprocess.TimeoutExpired:
            self.send_json(422, {"error": "Compilation timed out.", "details": "The compiler exceeded 210 seconds."})
        except Exception as error:
            self.send_json(500, {"error": "Compiler failed.", "details": str(error)[:500]})

    def log_message(self, format, *args):
        print(format % args, flush=True)


ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
