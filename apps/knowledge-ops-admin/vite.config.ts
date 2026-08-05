import { defineConfig } from "vite";
export default defineConfig({build:{target:"es2024",sourcemap:true},server:{port:19831,proxy:{"/v1":"http://127.0.0.1:19830"}}});
