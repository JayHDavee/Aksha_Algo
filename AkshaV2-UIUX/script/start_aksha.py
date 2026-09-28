import subprocess
import os
os.chdir("/opt/backend")
os.environ['NODE_PORT']='5000'
subprocess.call(["pm2", "--name",  "akshabackend",  "start",  "npm",  "--",  "start"]);
subprocess.call(["nginx", "-g", "daemon off;"]);
