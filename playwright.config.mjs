import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/browser',workers:1,timeout:30000,use:{baseURL:'http://127.0.0.1:4187',viewport:{width:402,height:874},isMobile:true,hasTouch:true,launchOptions:{executablePath:'/usr/bin/chromium',args:['--no-sandbox']}},reporter:'list',outputDir:'artifacts/browser'});
