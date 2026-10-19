# 把三千棵🌳種回來

市政 debug松 #1「樹蔭公平」作品。用臺北市的開放資料，找出該補種、也能補種的地點，並標出 2024 年以來從資料中消失的行道樹。

## 資料來源

| 檔案 | 來源 | 類型 |
| --- | --- | --- |
| `street_trees.csv` | [臺北市行道樹及公園樹木分布圖](https://data.gov.tw/dataset/128274)：行道樹 | 真實開放資料（活動頁提供） |
| `park_trees.csv` | 同上：公園樹木 | 真實開放資料（活動頁提供） |
| `tree_pits_nco.geojson` | [臺北市人行道固定設施物＿樹穴](https://data.gov.tw/dataset/134908)（新工處） | 真實開放資料（活動頁提供） |
| `sidewalks.json` | [臺北市人行道範圍圖](https://data.taipei/dataset/detail?id=715d3a83-8445-4496-b6bf-b0900538b7e7) | 真實開放資料（活動頁提供） |
| `street_trees_2024-11-21.csv` | 同一個官方行道樹檔案的舊版，由 [Wayback Machine](https://web.archive.org/web/20241121065019/https://tppkl.blob.core.windows.net/blobfs/TaipeiTree.csv) 存檔 | 真實資料，經第三方存檔（非活動頁提供） |
| `village_population_by_age.csv` | [臺北市各里人口數按年齡分](https://data.taipei/dataset/detail?id=a6394e3f-3514-4542-87bd-de4310a40db3)（民政局，取最新月份） | 真實開放資料（活動頁 #6 提供） |
| `villages_moi.zip` | [村里界圖（TWD97 經緯度）](https://data.gov.tw/dataset/7438)（內政部國土測繪中心） | 真實開放資料（非活動頁提供） |
| `zoning_main.zip` | [臺北市都市計畫使用分區圖](https://data.gov.tw/dataset/156197)：全市主要計畫（都發局），只用「保護區」 | 真實開放資料（data.taipei，非 #1 題目列出） |
| 網頁底圖、113／114 年航照 | 內政部國土測繪中心 WMTS 圖磚服務 | 真實開放資料（非活動頁提供） |
| 移除原因 | 未開放 | 不使用 |

每個檔案的下載網址、下載時間和 SHA-256 記錄在 `data/raw/manifest.json`。目前沒有使用任何模擬資料，也沒有使用任何個資。

## 怎麼跑

分析只需要 Python 3.9 以上，不用安裝任何套件。`build_web.py` 會呼叫 Node 把各里圖層轉成 TopoJSON，第一次要先執行 `npm install`。

```bash
python3 scripts/fetch_data.py      # 下載原始資料到 data/raw
python3 scripts/classify.py        # 樹穴分級、找出消失的樹 → data/processed
python3 scripts/villages.py        # 里層級遮蔭指數 → data/processed/villages.geojson
python3 scripts/build_web.py       # 整理網頁用的資料 → web/data
python3 scripts/sample.py          # 產生抽查清單 → data/sample/checklist.csv
python3 scripts/score_sample.py    # 抽查填完後，計算各類命中率
```

網頁原型是純靜態網站，本機預覽：

```bash
python3 scripts/serve_web.py    # 打開 http://127.0.0.1:8765（關閉快取，改完重新整理就看得到）
```

網址加 `?v=<里代碼>` 會直接打開那個里（分享連結就是這個格式）。網址帶 `mode=` 參數時視為誤貼的網址列，會開啟預設的樹蔭頁。「查我家附近」需要 HTTPS 或 localhost 才能定位。

線上版：<https://sianchen.github.io/taipei-tree-shade/>。`web/` 的改動 commit 到 main 之後，執行 `scripts/deploy_web.sh` 就會發布到 `gh-pages` 分支，GitHub Pages 一兩分鐘內更新。

## 分析規則

所有距離都以 TWD97（EPSG:3826）公尺計算，輸出時轉成 WGS84 經緯度。

**樹穴分級**（只計「樹穴」，不含「花圃」；以樹穴中心點和樹的座標比對）：

| 類別 | 條件 | 意義 |
| --- | --- | --- |
| has_tree | 3 m 內有現存行道樹 | 正常 |
| A | 現在空的，但 2024-11 時 1.5 m 內有行道樹 | 移除後沒有補植 |
| park | 1.5 m 內有公園樹木 | 由公園樹木資料涵蓋，不算空 |
| B | 空的，15 m 內有現存行道樹 | 有種樹的路段上的缺株 |
| C | 空的，15 m 內沒有行道樹 | 待確認，也可能是行道樹資料沒有涵蓋 |

**消失的樹**：2024-11 快照中有、現在檔案中沒有的樹籍編號，而且現在 5 m 內沒有任何行道樹或公園樹木。這樣可以排除重新編號或重新測量座標的樹。

**里層級遮蔭指數**（`scripts/villages.py`）：

- **行道樹和公園樹木都算**：樹蔭不分是哪一份清冊上的樹。
- **樹冠面積是估計值**：樹冠直徑（公尺）= 0.24 × 胸徑（公分），限制在 1.5 到 20 公尺之間。胸徑缺漏時用同一檔案中同樹種的中位數，超過 200 公分視為誤植。指數只用來比較各里高低，係數改變不影響排名。
- **里界附近的樹兩邊都算**：里界多沿道路中線劃，所以樹只要在里內、或在里界 25 m 內，就算給每個相鄰的里。範圍改成 15 m 或 30 m，最缺樹蔭的 20 個里有 19 到 20 個不變。
- **主要指標**：每人分到的樹冠面積（行道樹＋公園樹木，m²／人），人口取民政局最新月份。
- **資料沒有涵蓋的樹**：兩份清冊只有公園處管理的行道樹和公園樹木，不含山林、校園、私人庭院，也不含水利處管理的河濱公園。
- **山區和靠山的里不排名**，因為它們的樹蔭主要來自清冊以外的山林。456 個里中有 403 個列入排名：
  - 每公頃不到 5 人的里：陽明山、貓空的 8 個里。門檻原本是 20 人，但會把台大所在的學府里、松山機場所在的精忠里，以及社子島的富洲里（5,674 人、0 棵行道樹）也排除掉，因此調降。
  - 面積 30% 以上是都市計畫「保護區」（山坡地）的里：另外 45 個，例如內湖碧山里、士林永福里、信義泰和里。比例以 5 m 間距的掃描線計算。最接近門檻的是北投中和里 30.4%、信義三犁里 30.1%（不排名），以及文山萬盛里 29.6%、華興里 29.3%（列入排名）。陽明山不在臺北市都市計畫範圍內，所以仍需要人口密度門檻。
- **同分並列**：數值相同的里並列同一名。
- **地圖色階**：6 階，把 403 個列入排名的里按每人樹蔭排序後平均分成 6 份，每階 67 或 68 個里。目前的切點是每人 1.15、2.0、2.91、4.02、6.32 m²，會隨資料更新重算。超過 7 階時相鄰顏色在地圖上分不出來，所以不再加階。

## 抽查方法

`data/sample/checklist.csv` 從 A、B、C 和「消失的樹」四類各隨機抽 20 個點（固定亂數種子，可以重現）。

1. 點「街景連結」開啟 Google 街景。
2. 確認現場有沒有樹；需要看過去的影像時，點左上角的日期切換到較早的拍攝時間。
3. 在「判讀結果」填 `有樹`、`無樹` 或 `無法判斷`，並記下街景影像日期。
4. 執行 `python3 scripts/score_sample.py` 算出各類命中率。

## 限制

- 資料中少了一棵樹，不等於樹被砍了；也可能是資料清理、重新測量或移植。
- 空樹穴不一定能種：可能正在施工、被蓋板蓋住，或面積太小。
- 街景影像可能比資料舊，看不到最近的變化。
- 官方行道樹檔案幾乎每天更新，結果會隨下載日期小幅變動。每次的數字和下載時間都記在 `data/processed/summary.json`。

## 使用的開源套件與 AI 工具

- 分析只用 Python 標準函式庫。座標轉換是自己實作的 TM2 反算，並用 [pyproj](https://pyproj4.github.io/pyproj/) 驗證（2 萬個隨機點，最大誤差 0.06 mm）。Shapefile 也用自己寫的簡易讀取器（`scripts/shapefile_lite.py`）。
- 網頁地圖：[MapLibre GL JS](https://maplibre.org/) 4.7.1。各里圖層用 [TopoJSON](https://github.com/topojson/topojson) 傳送（建置時用 topojson-server 轉換，瀏覽器用 topojson-client 還原），檔案約為 GeoJSON 的一半。
- 網站圖示：[Noto Emoji](https://github.com/googlefonts/noto-emoji) 的 🌳（圖片資源採 Apache License 2.0）。
- 造訪人數：[GoatCounter](https://www.goatcounter.com/)，不使用 cookie、不記錄個資。面板顯示的人數讀自它的公開計數器，最多延遲 4 小時。「查過里的樹蔭」只在使用者自己點選里或按「查我家附近」時記一次，從分享連結打開的里不算。
- [Claude Code](https://claude.com/claude-code)（Anthropic）協助資料探索與程式撰寫。

## 100 天計畫

（待完成：執行單位、所需資料、預估成本）
