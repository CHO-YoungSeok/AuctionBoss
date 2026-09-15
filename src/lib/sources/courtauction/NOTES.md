# 대한민국 법원경매정보 (courtauction.go.kr) — 내부 API 조사 노트

조사일: 2026-09-06 (task 3.1, RESEARCH ONLY)

---

## Status — 확인된 것 vs 미확인

각 항목에 `CONFIRMED`(실제로 사이트에 요청을 보내 응답을 받아 확인) / `DERIVED`(사이트가 내려주는 프론트엔드 소스코드에서 읽었지만 직접 호출로는 검증 안 함) / `UNVERIFIED`(추측 또는 검색 결과만)를 표시한다.

| 항목 | 상태 |
|---|---|
| 사이트가 WebSquare5 SPA이고 내부 엔드포인트가 `/pgj/**.on` (POST + JSON) 형태 | **CONFIRMED** |
| 물건검색 엔드포인트 `POST /pgj/pgjsearch/searchControllerMain.on` | **CONFIRMED** — 실제 호출해서 444건 결과 수신 |
| 요청 바디 = `{dma_pageInfo, dma_srchGdsDtlSrchInfo}` | **CONFIRMED** |
| 응답 = `{status, message, timestamp, errors, data:{dma_pageInfo, ipcheck, dlt_srchResult[]}}` | **CONFIRMED** |
| 결과 row 필드명 전체 (아래 매핑표) | **CONFIRMED** — 실제 응답 JSON에서 그대로 추출 |
| 법원코드 목록 엔드포인트 `POST /pgj/pgj002/selectCortOfcLst.on` + 60개 법원 코드 | **CONFIRMED** — 실제 호출해서 전체 목록 수신 |
| 서울중앙지방법원 = `B000210` | **CONFIRMED** (코드 목록 + 결과 row의 `jiwonNm`이 "서울중앙지방법원") |
| 페이지네이션 파라미터 이름/의미 | **DERIVED** (프론트 JS에서 읽음) — **page 2 실제 호출 검증 실패** (IP 차단). 아래 §6.1 참조 |
| 로봇탐지 IP 차단이 최소 13분 이상 지속 | **CONFIRMED** (§6.1 타임라인) |
| 브라우저 User-Agent 필수 (curl 기본 UA면 WAF가 HTML 차단 페이지 반환) | **CONFIRMED** |
| 세션 쿠키(JSESSIONID/WMONID) 필요 여부 | **UNVERIFIED** — 쿠키 있는 상태에서만 성공했고, 쿠키 없는 대조군은 이미 IP가 차단된 뒤라 결론 불가 |
| Referer / Origin / X-Requested-With 필요 여부 | **UNVERIFIED** — 같은 이유 |
| `ipcheck` = 로봇탐지 플래그, IP 차단 시 `false` + 결과 비어있음 | **CONFIRMED** |
| 코드값 `cortAuctnSrchCondCd=0004601`(부동산) / `0004604`(동산), `mvprpRletDvsCd=00031R`/`00031M` | **DERIVED** (PGJ151F01.xml JS 소스) + 0004601/00031R 조합은 실제 호출로 동작 **CONFIRMED** |
| `bidDvsCd=000331`의 정확한 의미(기일입찰 추정) | **UNVERIFIED** |
| `jinstatCd`(진행상태코드) 값→이름 매핑 | **UNVERIFIED** — 응답에서 값(`0002100001`)은 받았으나 코드표를 못 찾음 |
| 물건상세 엔드포인트 `/pgj/pgj15B/selectAuctnCsSrchRslt.on` | **DERIVED** — 호출 안 해봄 |

> 검색(구글/한국어 검색)으로는 **쓸 만한 게 하나도 안 나왔다.** 이 사이트의 신 엔드포인트를 문서화한 공개 GitHub 레포를 찾지 못했다. 아래 내용은 전부 (a) 사이트가 직접 내려주는 WebSquare 화면정의 XML / JS 소스를 읽고 (b) 실제로 호출해서 얻은 것이다.

---

## 1. 사이트 구조 (배경)

`https://www.courtauction.go.kr/pgj/index.on` 은 **WebSquare5**(인스웨이브) SPA 껍데기다. HTML 본문은 비어 있고, 화면은 `/pgj/ui/pgj100/*.xml` 이라는 화면정의 XML을 런타임에 로드해서 그린다. 이 XML 안에 `<xf:submission>` 태그로 **서버 엔드포인트, HTTP 메서드, 요청 바디 구조, 응답 바인딩 경로**가 전부 평문으로 들어있다. 즉 HTML 파싱이 아니라 XML을 읽으면 API 스펙이 그대로 나온다.

핵심 파일 (인증 없이 GET 가능, **CONFIRMED**):

| URL | 내용 |
|---|---|
| `/pgj/ui/pgj100/PGJ151F00.xml` | 물건상세검색 프레임 (검색 submission 정의) |
| `/pgj/ui/pgj100/PGJ151F01.xml` | 물건상세검색 **입력폼** — 검색 파라미터 조립 로직 전체 |
| `/pgj/ui/pgj100/PGJ151M01.xml` | 물건상세검색 **결과화면(부동산)** — 결과 컬럼 정의 + 페이징 로직 |
| `/pgj/ui/pgj100/PGJ15BM01.xml` | 물건 상세내역 화면 |
| `/pgj/cm/js/pgj.js` | `pgjUtil` — 법원/주소/용도 코드 조회 헬퍼 (엔드포인트 목록이 여기 있음) |
| `/pgj/websquare/config.xml` | 로드되는 JS 파일 전체 목록 |

---

## 2. Endpoint — 물건검색

### 2.1 요청 (**CONFIRMED**)

```
POST https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on
Content-Type: application/json;charset=UTF-8
```

> 화면정의 XML에는 `action="/pgj//pgjsearch/searchControllerMain.on"` (슬래시 2개)로 적힌 곳도 있는데, 결과화면(PGJ151M01.xml)의 것은 슬래시 1개다. 슬래시 1개로 정상 동작함을 확인했다.

**실제로 200 + 정상 결과를 받은 요청 그대로:**

```bash
# 1) 먼저 세션 쿠키를 받는다 (JSESSIONID, WMONID, SID, cortAuctnLgnMbr)
curl -s -c cj.txt -A "$UA" -o /dev/null \
  'https://www.courtauction.go.kr/pgj/index.on'

# 2) 검색
curl -s -b cj.txt -A "$UA" \
  -H 'Content-Type: application/json;charset=UTF-8' \
  -H 'Accept: application/json' \
  -H 'Referer: https://www.courtauction.go.kr/pgj/index.on' \
  -H 'Origin: https://www.courtauction.go.kr' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -X POST --data-binary @body.json \
  'https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on'
```

`UA` = 평범한 크롬 UA 문자열. **curl 기본 UA를 쓰면 WAF가 JSON이 아니라 "The request / response that are contrary to the Web firewall security policies have been blocked." 라는 HTML을 200으로 반환한다 (CONFIRMED).**

`body.json` (**이 바디로 실제 444건을 받았다**):

```json
{
  "dma_pageInfo": {
    "pageNo": 1,
    "pageSize": 10,
    "bfPageNo": 1,
    "startRowNo": "",
    "totalCnt": 0,
    "totalYn": "Y",
    "groupTotalCount": ""
  },
  "dma_srchGdsDtlSrchInfo": {
    "rletDspslSpcCondCd": "",
    "bidDvsCd": "000331",
    "mvprpRletDvsCd": "00031R",
    "cortAuctnSrchCondCd": "0004601",
    "cortOfcCd": "B000210",
    "jdbnCd": "",
    "lclDspslGdsLstUsgCd": "",
    "mclDspslGdsLstUsgCd": "",
    "sclDspslGdsLstUsgCd": "",
    "cortStDvs": "1",
    "lafjOrderBy": "",
    "pgmId": "PGJ15AF01",
    "bidBgngYmd": "20260901",
    "bidEndYmd": "20261031",
    "srchInfo": {}
  }
}
```

> 어느 필드가 **필수**인지는 개별로 분리 검증하지 못했다 (IP 차단 때문). 위 조합이 동작한다는 것만 확실하다. `srchInfo: {}` 는 필요 없을 가능성이 높다(프론트가 안 보냄) — 넣어도 문제는 없었다.

### 2.2 `dma_srchGdsDtlSrchInfo` 전체 키 목록 (**DERIVED** — PGJ151M01.xml `<w2:dataMap id="dma_srchGdsDtlSrchInfo">`)

| 키 | 의미 |
|---|---|
| `mvprpRletDvsCd` | 동산/부동산 구분. `00031R`=부동산, `00031M`=동산 |
| `cortAuctnSrchCondCd` | 검색조건 구분. `0004601`=물건상세검색(부동산), `0004604`=물건상세검색(동산) |
| `cortStDvs` | 검색 기준. `1`=법원/담당계, `2`=소재지(지번주소), `3`=소재지(새주소) |
| `cortOfcCd` | 법원사무소코드 (예 `B000210`) |
| `jdbnCd` | 담당계(부서) 코드 |
| `bidDvsCd` | 입찰구분 (관측값 `000331`) |
| `csNo` | 사건번호 |
| `bidBgngYmd` / `bidEndYmd` | 입찰(매각기일) 시작/종료 일자, `YYYYMMDD` |
| `dspslDxdyYmd` | 매각기일 (기일별검색용) |
| `lclDspslGdsLstUsgCd` / `mclDspslGdsLstUsgCd` / `sclDspslGdsLstUsgCd` | 용도 대/중/소분류 코드 |
| `aeeEvlAmtMin` / `aeeEvlAmtMax` | 감정평가액 범위 |
| `lwsDspslPrcMin` / `lwsDspslPrcMax` | 최저매각가격 범위 |
| `lwsDspslPrcRateMin` / `lwsDspslPrcRateMax` | 최저매각가율(%) 범위 |
| `flbdNcntMin` / `flbdNcntMax` | 유찰횟수 범위 |
| `objctArDtsMin` / `objctArDtsMax` | 면적 범위 |
| `rprsAdongSdCd` / `rprsAdongSggCd` / `rprsAdongEmdCd` | 소재지(지번) 시도/시군구/읍면동 |
| `rdnmSdCd` / `rdnmSggCd` / `rdnmNo` | 소재지(도로명) 시도/시군구/도로명 |
| `rletDspslSpcCondCd` | 특수조건 코드(콤마 구분 다중값) |
| `notifyLoc` | 주소 공고중 포함 여부 (`on`/`off`) |
| `lafjOrderBy` | 정렬. `"<필드> asc"` 또는 `"<필드> desc"`. 필드: `csNo`, `aeeEvlAmt`, `pbancLwsDspslPrc`, `dspslDxdyYmd`, `flbdNcnt` |
| `pgmId` | 화면ID. 프론트는 `PGJ151M01`(부동산 결과화면) 등을 보냄 |
| `statNum` | 프론트가 `1` 고정으로 보냄 (주석에 "익수주임님" — 의미 불명) |
| 그 외 `mvprp*` | 동산(집행관) 전용 필드 |

---

## 3. Response shape (**CONFIRMED**)

```
{
  "status": 200,
  "message": "검색 결과가 조회되었습니다.",
  "timestamp": 1788675327824,
  "errors": null,
  "token": null,
  "data": {
    "dma_pageInfo": { ... },
    "ipcheck": true,               // 로봇탐지 통과 여부
    "dlt_srchResult": [ ... ]      // ★ 물건 배열
  }
}
```

**아이템 배열 JSON 경로: `data.dlt_srchResult`** (배열)
**페이징 정보 경로: `data.dma_pageInfo`**

`data.dma_pageInfo` 실제 값:
```json
{"pageNo":1,"pageSize":10,"bfPageNo":1,"startRowNo":1,"totalCnt":"444","totalYn":"Y","groupTotalCount":389}
```
- `totalCnt` = 총 **행** 수 (문자열). 한 행 = `(사건, 물건번호, 목적물번호)` 조합
- `groupTotalCount` = 총 **물건** 수 (숫자). 한 물건 = `(사건, 물건번호)`

**둘이 다른 이유 (CONFIRMED):** 일괄매각 물건은 목적물이 여러 개라 **같은 `saNo`+`maemulSer`가 `mokmulSer`만 다른 여러 행으로 나온다.** 실제 응답 page 1에서:

```
docid                    saNo/maemulSer/mokmulSer   mulBigo
B0002102024013000370211  2024타경3702 / 1 / 1       일괄매각
B0002102024013000370212  2024타경3702 / 1 / 2       일괄매각
B0002102024013000370213  2024타경3702 / 1 / 3       일괄매각
```
`docid` = `boCd` + `saNo` + `maemulSer` + `mokmulSer` 로 조립되며 행마다 **유일하다** (10건 모두 distinct 확인).

우리 도메인 자연키는 `(court, caseNo, itemNo)` = `(jiwonNm, srnSaNo, maemulSer)`이므로 **목적물 행을 접어야(dedupe) 한다.**

접을 때 `printSt`가 목적물마다 다르다는 점이 문제다 (실제 page 1 데이터, **CONFIRMED**):
```
2024타경2532 물건1 목적물1  서울특별시 종로구 평창동 445-1
2024타경2532 물건1 목적물2  서울특별시 종로구 평창6길 70          ← 도로명 표기
2024타경3702 물건1 목적물1  서울특별시 종로구 종로4가 185
2024타경3702 물건1 목적물2  서울특별시 종로구 종로4가 185-1
2024타경3702 물건1 목적물3  서울특별시 종로구 종로 204            ← 도로명 표기
```
지번주소와 도로명주소가 섞여 있어 단순히 이어붙이면 같은 곳이 두 번 들어간다.

구분자는 **`addrGbncd`**다 (page 1의 10행 전부에서 상관관계 확인, **CONFIRMED**):
- `addrGbncd == "A"` → **지번주소** (`rdNm`이 빈 문자열)
- `addrGbncd == "R"` → **도로명주소** (`rdNm`에 도로명이 들어있음, 예 `"퇴계로"`, `"남부순환로192길"`)

**추천 처리:** 물건 단위로 접을 때 `addrGbncd == "A"`인 첫 행의 `printSt`를 `address`로 쓴다. `A` 행이 없으면 `R` 행 첫 번째를 쓴다. (모든 물건에 A 행이 항상 있는지는 **UNVERIFIED** — 위 샘플에서 `2024타경2501`, `2024타경3528`은 R 행만 있었다.)

### 3.1 필드 매핑표 (**CONFIRMED** — 실제 응답 row에서 발췌)

`AuctionItemInput` (`src/lib/domain/types.ts`) 기준 매핑:

| `AuctionItemInput` 필드 | courtauction 필드 | 예시 값 | 변환 |
|---|---|---|---|
| `court` | `jiwonNm` | `"서울중앙지방법원"` | 그대로 |
| `caseNo` | `srnSaNo` | `"2011타경28497"` | 그대로 (`printCsNo`는 HTML이라 쓰지 말 것) |
| `itemNo` | `maemulSer` | `"1"` | 그대로 |
| `address` | `printSt` | `"서울특별시 성북구 정릉동 1032 정릉2차 대주피오레 203동 4층 401호"` | 그대로 (단, 목적물 행 접기 규칙은 §3 참조) |
| `usageType` | `dspslUsgNm` | `"아파트"` | 그대로 |
| `appraisalPrice` | `gamevalAmt` | `"711000000"` | `Number()` — 문자열로 온다 |
| `minBidPrice` | **`notifyMinmaePrice1`** (권장) / `minmaePrice` | `"711000000"` | `Number()` — 아래 주의 |
| `auctionDate` | `maeGiil` | `"20260908"` | `YYYYMMDD` → `YYYY-MM-DD` |
| `failedBidCount` | `yuchalCnt` | `"1"` | `Number()` |
| `status` | ⚠️ 소스에 직접 대응하는 문자열 필드가 **없다** | — | 아래 주의 참조 |

> **`minBidPrice` 선택 주의**: `minmaePrice`와 `notifyMinmaePrice1`은 값이 다를 수 있다.
> - **화면의 "최저매각가격" 컬럼이 쓰는 것은 `notifyMinmaePrice1`이다** — PGJ151M01.xml grid 컬럼 id가 `notifyMinmaePrice1`이고 formatter가 `scwin.lwsPrcFormat` (**CONFIRMED**, 소스 코드).
> - 관측 샘플 10건에서 `yuchalCnt > 0`인 행은 전부 `notifyMinmaePrice1 == minmaePrice * 0.8`, `yuchalCnt == 0`인 행은 두 값이 같았다 — 단 `2011타경28497`(yuchalCnt=1)만 예외로 두 값이 같았다. 두 필드의 정확한 정의는 **UNVERIFIED**.
> - **구현 시 화면과 일치시키려면 `notifyMinmaePrice1`을 쓸 것.** 둘 다 저장해두고 나중에 비교하는 것도 방법.
> - `notifyMinmaePrice2..4`가 0이 아니면 한 물건에 매각기일이 여러 차 잡혀 있다는 뜻이다 (`scwin.lwsPrcFormat`이 1~4차를 나열해서 그린다).

> **`status` 주의 (CONFIRMED from PGJ151M01.xml JS):** 화면의 "진행상태" 컬럼은 상태 코드가 아니라 `yuchalCnt`를 포맷해서 보여준다:
> ```js
> scwin.flbdCnt = function (data) { return data == 0 ? `신건` : `유찰 ${data}회` }
> ```
> 즉 `yuchalCnt === "0"` → `"신건"`, 그 외 → `"유찰 N회"`. `status`를 채우려면 이 규칙을 그대로 쓰는 게 화면과 일치한다.
> 원시 상태 코드 `jinstatCd`(`"0002100001"`), `mulStatcd`(`"01"`), `mulJinYn`(`"Y"`)도 오지만 **코드표를 못 찾았다 (UNVERIFIED)**. 관측 10건이 전부 같은 값이라 의미 추정 불가.

부가 필드 (정규화 모델에는 없지만 저장/디버깅에 유용, **CONFIRMED**):

| 의미 | 필드 | 예시 값 |
|---|---|---|
| 물건 고유 ID (dedupe 키로 최적) | `docid` | `"B0002102011013002849711"` |
| 사건번호 (내부키) | `saNo` | `"20110130028497"` |
| 목적물번호 | `mokmulSer` | `"1"` |
| 법원코드 | `boCd` | `"B000210"` |
| 담당계 / 코드 / 전화 | `jpDeptNm` / `jpDeptCd` / `tel` | `"경매1계"` / `"1001"` / `"530-1820 (제4별관 민사집행과)"` |
| 소재지 분해 | `hjguSido` / `hjguSigu` / `hjguDong` / `daepyoLotno` / `buldNm` / `buldList` | `"서울특별시"` / `"성북구"` / `"정릉동"` / `"1032"` / `"정릉2차 대주피오레"` / `"203동 4층 401호"` |
| 용도 코드 | `lclsUtilCd` / `mclsUtilCd` / `sclsUtilCd` | `"20000"` / `"20100"` / `"20104"` |
| 차수별 최저가 | `notifyMinmaePrice1..4` | `"711000000"`, `"0"`, `"0"`, `"0"` |
| 차수별 최저가율(%) | `notifyMinmaePriceRate1..2` | `"100"` |
| 매각기일 시각 (1~4차) | `maeHh1..4` | `"1000"` (= 10:00) |
| 매각결정기일 | `maegyuljGiil` | `"20260915"` |
| 매각기일 회차 | `maeGiilCnt` | `"1"` |
| 매각장소 | `maePlace` | `"경매법정(제4별관211호)"` |
| 입찰구분 | `ipchalGbncd` | `"000331"` |
| 기간입찰 시작/종료 | `ipgiganFday` / `ipgiganTday` | `""` (기일입찰이면 빈값) |
| 매각금액(낙찰가) | `maeAmt` | `"0"` (미낙찰이면 0) |
| 조회수 / 관심등록수 | `inqCnt` / `gwansMulRegCnt` | `"55"` / `"8"` |
| 비고 | `mulBigo` | `""` |
| 중복/병합사건 | `dupSaNo` / `byungSaNo` | `"2015타경14083<br/>2021타경102844"` / `""` |
| 면적(㎡) | `minArea` / `maxArea` / `pjbBuldList` | `"84"` / `"84"` / `"철근콘크리트구조\n84.99㎡"` |
| 좌표 | `xCordi` / `yCordi` / `cordiLvl` | `"312690"` / `"555963"` / `"1"` (좌표계 불명) |
| WGS84 좌표 | `wgs84Xcordi` / `wgs84Ycordi` | `"127"` / `"37"` — **정수 단위라 사실상 쓸모없음** |

> `CourtRef.courtCode`에는 `cortOfcCd`(예 `B000210`)를 넣으면 된다. §4 참조.

> **진행상태 주의 (CONFIRMED from PGJ151M01.xml JS):** 화면의 "진행상태" 컬럼은 `jinstatCd`가 아니라 `yuchalCnt`를 포맷해서 보여준다:
> ```js
> scwin.flbdCnt = function (data) { return data == 0 ? `신건` : `유찰 ${data}회` }
> ```
> 즉 `yuchalCnt === "0"` → "신건", 그 외 → "유찰 N회". `jinstatCd`(`0002100001`)와 `mulStatcd`(`01`)의 코드표는 **찾지 못했다 (UNVERIFIED)**. 관측 샘플 10건이 모두 같은 값이라 의미 추정 불가.

> 모든 금액/횟수 필드는 **문자열**로 온다. 숫자 변환은 우리 쪽에서 해야 한다.

---

## 4. 법원코드 (Court codes)

### 4.1 코드 체계 (**CONFIRMED**)

- 형식: `<구분1자><숫자6자>`. 앞 글자 `B` = 부동산(법원), `O` = 동산(집행관사무소).
- 조회 엔드포인트 (**CONFIRMED — 실제 호출 성공**):

```bash
curl -s -A "$UA" -H 'Content-Type: application/json;charset=UTF-8' \
  -H 'Referer: https://www.courtauction.go.kr/pgj/index.on' \
  -X POST -d '{"cortExecrOfcDvsCd":"00079B"}' \
  'https://www.courtauction.go.kr/pgj/pgj002/selectCortOfcLst.on'
```
- `cortExecrOfcDvsCd` = `"00079"` + `B`(부동산) 또는 `O`(집행관). (pgj.js `pgjUtil.getCortOfcLst`)
- 응답: `data.cortOfcLst` = `[{"code":"B000210","name":"서울중앙지방법원"}, ...]` — **부동산 기준 60개**

### 4.2 **서울중앙지방법원 = `B000210`** (**CONFIRMED**, 결과 row의 `jiwonNm`으로 교차확인)

전체 목록 (부동산, **CONFIRMED**, 응답 순서 그대로):

```
B000210 서울중앙지방법원   B000211 서울동부지방법원   B000215 서울서부지방법원
B000212 서울남부지방법원   B000213 서울북부지방법원   B000214 의정부지방법원
B214807 고양지원          B214804 남양주지원         B000240 인천지방법원
B000241 부천지원          B000250 수원지방법원        B000251 성남지원
B000252 여주지원          B000253 평택지원           B250826 안산지원
B000254 안양지원          B000260 춘천지방법원        B000261 강릉지원
B000262 원주지원          B000263 속초지원           B000264 영월지원
B000270 청주지방법원       B000271 충주지원           B000272 제천지원
B000273 영동지원          B000280 대전지방법원        B000281 홍성지원
B000282 논산지원          B000283 천안지원           B000284 공주지원
B000285 서산지원          B000310 대구지방법원        B000311 안동지원
B000312 경주지원          B000313 김천지원           B000314 상주지원
B000315 의성지원          B000316 영덕지원           B000317 포항지원
B000320 대구서부지원       B000410 부산지방법원        B000412 부산동부지원
B000414 부산서부지원       B000411 울산지방법원        B000420 창원지방법원
B000431 마산지원          B000421 진주지원           B000422 통영지원
B000423 밀양지원          B000424 거창지원           B000510 광주지방법원
B000511 목포지원          B000512 장흥지원           B000513 순천지원
B000514 해남지원          B000520 전주지방법원        B000521 군산지원
B000522 정읍지원          B000523 남원지원           B000530 제주지방법원
```

### 4.3 관련 코드 목록 엔드포인트 (**DERIVED** — pgj.js에서 추출, `selectCortOfcLst.on` 외에는 호출 안 해봄)

전부 `POST`, `application/json`. 요청 파라미터는 pgj.js의 해당 함수를 보면 된다.

| 엔드포인트 | 용도 |
|---|---|
| `/pgj/pgj002/selectCortOfcLst.on` | 법원사무소 목록 ✅ CONFIRMED |
| `/pgj/pgj002/selectCortOfcDeptLst.on` | 담당계(부서) 목록 |
| `/pgj/pgj002/selectLclLst.on` | 용도 대분류 |
| `/pgj/pgj002/selectMclLst.on` | 용도 중분류 |
| `/pgj/pgj002/selectSclLst.on` | 용도 소분류 |
| `/pgj/pgj002/selectSpcCondLst.on` | 특수조건 목록 |
| `/pgj/pgj002/selectAdongSdLst.on` / `selectAdongSggLst.on` / `selectAdongEmdLst.on` | 행정동 시도/시군구/읍면동 |
| `/pgj/pgj002/selectRdnmAddr.on` / `selectRnConsonantLst.on` | 도로명 주소 |
| `/pgj/pgj002/selectMvprpRletSdCortOfcLst.on` | 시도별 법원 목록 |
| `/pgj/pgj15B/selectAuctnCsSrchRslt.on` | **물건 상세내역** — 요청: `{csNo, cortOfcCd, dspslGdsSeq, pgmId, srchInfo}`, 응답 바인딩 `data.dma_result` |
| `/pgj/pgj15B/selectAuctnTongSrchRslt.on` | 인근매각통계 |
| `/pgj/pgj141/selectAuctnPbancNtcMtrLst.on` | 매각공고 목록 |

---

## 5. Pagination

**DERIVED** (PGJ151M01.xml `scwin.gdsDtlSrchMain`, `scwin.pgl_gdsDtlSrchPage_onviewchange`).
⚠️ **page 2 실제 호출은 IP 차단 때문에 검증하지 못했다 (UNVERIFIED).** 구현자가 가장 먼저 확인해야 할 항목이다.

```js
// 첫 조회
dma_pageInfo.set("totalYn", "Y");   // 총건수도 같이 계산
dma_pageInfo.set("pageNo", scwin.pageNum);
dma_pageInfo.set("pageSize", pagaSize);

// 페이지 이동
dma_pageInfo.set("pageNo", info.newSelectedIndex);   // 1-based
dma_pageInfo.set("bfPageNo", info.oldSelectedIndex);
dma_pageInfo.set("totalYn", "N");   // 이후 조회는 총건수 재계산 안 함
```

정리:
- `pageNo`: 1부터 시작
- `pageSize`: UI 기본 10 (쿠키 `pageCnt`로 변경 가능; UI 셀렉트박스 제공)
- `totalYn`: 첫 조회 `"Y"`, 이후 `"N"`
- `bfPageNo`: 직전 페이지 번호 (서버가 실제로 쓰는지는 불명)
- 종료조건: `data.dma_pageInfo.totalCnt` (총 행 수) 기준으로 `ceil(totalCnt / pageSize)` 페이지까지
- 응답 `startRowNo`가 1-based 시작 행번호로 에코된다 (page 1에서 `1` 확인)

**행 접기 주의**: 페이지 크기(`pageSize`)는 **물건 수가 아니라 행 수**에 적용된다. 일괄매각 물건은 목적물 수만큼 행을 차지하므로 `pageSize=10`이어도 실제 물건은 그보다 적다 (§3 참조). 전체 순회 종료 조건은 `totalCnt`(행 수) 기준으로 계산할 것 — `groupTotalCount`(물건 수)로 계산하면 뒷 페이지를 놓친다.
UI는 이 목적물 행들을 `colMerge`/`upperColumn="colMerge"` 속성으로 rowspan 병합해서 한 물건처럼 보여준다.

---

## 6. Blockers / Open questions

### 6.1 ★ 로봇탐지 / IP 차단 (가장 중요) — **CONFIRMED**

- 응답 안에 `data.ipcheck` 불리언이 있다. 프론트 코드가 `if (e.responseJSON.data.ipcheck) { 결과 렌더 }` 로 분기한다.
- 짧은 시간에 요청을 몇 번 보내자 (약 5분 사이에 **총 15회 미만**, 그중 검색 엔드포인트는 4회) 다음 응답으로 바뀌었다:
  ```json
  {"status":200,"message":"해당 IP는 비정상적인 접속으로 보안정책에의하여 차단되었습니다.",
   "errors":null,"data":{"ipcheck":false}}
  ```
  `dma_pageInfo`와 `dlt_srchResult`가 통째로 없어진다. **HTTP는 그대로 200이므로 status code로 실패를 감지할 수 없다 — 반드시 `data.ipcheck`와 `data.dlt_srchResult` 존재 여부를 봐야 한다.**
- **실측 타임라인 (응답의 `timestamp` 필드 기준, CONFIRMED):**

  | 시각(UTC) | 요청 | 결과 |
  |---|---|---|
  | 06:12:45 | `GET /pgj/index.on` | 200, 쿠키 발급 |
  | 06:15:27 | `POST searchControllerMain.on` (page 1) | ✅ `ipcheck:true`, 444건 |
  | ~06:16 | XML 6~7개 GET + `selectCortOfcLst.on` | ✅ 정상 |
  | 06:17:52 | `POST search` (curl 기본 UA) | ❌ WAF HTML 차단 페이지 |
  | 06:18:03 | `POST search` (브라우저 UA) ×2 | ❌ `ipcheck:false` |
  | 06:20:17 | `POST search` (쿠키 재발급 후) | ❌ `ipcheck:false` |
  | 06:31:08 | `POST search` (10분+ 대기 후, 쿠키 재발급) | ❌ `ipcheck:false` |

  → **차단이 최소 13분 이상 지속됐다.** 정확한 해제 시각은 더 이상 사이트를 두드리지 않기 위해 측정하지 않았다 (**UNVERIFIED**). 쿠키를 새로 받아도 풀리지 않으므로 **IP 단위 차단**이다.
- 성공한 응답에 `Set-Cookie: wcCookieV2=<내IP>_T_499539_WC; expires=<+1시간>` 이 있었다. WAF/로봇탐지 쿠키로 보이며 유효기간이 1시간이라 **차단도 1시간 단위일 가능성이 있다 (추측)**.
- 이 사이트는 별도의 WAF도 있다. 브라우저 UA가 아니면 (curl 기본 UA) JSON 대신 아래 HTML을 200으로 반환한다:
  > `The request / response that are contrary to the Web firewall security policies have been blocked. / Detect time / Detect client IP / Detect URL`

**구현자가 반드시 해결해야 할 것:**
1. **레이트 리밋을 아주 보수적으로.** 페이지당 최소 수 초 간격, 동시 요청 금지. 정확한 임계값은 미측정이지만 **5분에 15회 미만으로도 걸렸다**는 점에 유의.
2. 매 응답마다 `data.ipcheck !== true` 또는 `data.dlt_srchResult` 부재를 감지 → 즉시 중단 + 백오프 (**최소 1시간 권장** — 13분 대기로는 안 풀렸다). 재시도 시 쿠키를 새로 받아도 소용없다.
3. 브라우저 User-Agent 필수. 세션 쿠키는 `GET /pgj/index.on`으로 선취득해서 재사용.
4. `Content-Type`이 아니라 응답 본문 앞 글자로 HTML 차단 페이지를 판별하는 방어 코드 필요 (차단 페이지도 200으로 온다).

### 6.2 그 외 미해결

| # | 질문 | 왜 미해결인가 |
|---|---|---|
| 0 | spec의 "**진행 중** 물건만 조회" 요건을 어떤 파라미터로 표현하는가? | 이번 조회는 `bidBgngYmd`~`bidEndYmd`(향후 2개월 매각기일)로 범위를 좁혔고 결과가 전부 `mulJinYn="Y"`, `jinstatCd="0002100001"`이었다. 이게 "진행중"의 의미인지 **UNVERIFIED**. 실무적으로는 `bidBgngYmd = 오늘`로 두면 앞으로 매각기일이 잡힌 물건만 나온다(추측) |
| 1 | 요청 바디의 **최소 필수 필드**가 뭔가? | 필드별 분리 검증 전에 IP가 차단됨 |
| 2 | 쿠키/Referer/Origin/X-Requested-With가 실제로 필요한가? | 대조군 실험이 차단 상태에서 진행돼 결론 불가 |
| 3 | `bidDvsCd`의 코드값 전체 (`000331`은 뭔가?) | 라디오 옵션이 서버 코드조회로 동적 바인딩됨. `/pgj/pgj002/` 코드 엔드포인트 중 하나로 얻어야 함 |
| 4 | `jinstatCd`/`mulStatcd` 코드→명칭 매핑 | 코드표를 못 찾음. `sccdo.loadIntgCdLst('PGJ-<코드그룹>')` 형태의 통합코드 조회가 있는 것은 확인했으나 엔드포인트 미확인 |
| 5 | `bidBgngYmd`/`bidEndYmd`로 조회 가능한 **최대 기간** | 미검증 |
| 6 | `cortOfcCd` 없이 (전국) 조회가 되는가 | 미검증 |
| 7 | `xCordi`/`yCordi` 좌표계 (EPSG?) | 미확인. `wgs84*`는 정수라 못 씀 |
| 8 | 상세 엔드포인트 `selectAuctnCsSrchRslt.on`의 응답 스키마 | 호출 안 해봄. 요청은 `{csNo, cortOfcCd, dspslGdsSeq, pgmId, srchInfo}`, 응답은 `data.dma_result` (DERIVED) |
| 9 | robots.txt / 이용약관상 스크래핑 허용 여부 | **확인 안 함. 구현 전에 반드시 확인할 것.** |

---

## 7. 구현자 체크리스트 (task 3.2/3.3용 요약)

1. 수집 시작 시 `GET /pgj/index.on` 1회로 쿠키 확보 → 이후 요청에 재사용. 브라우저 UA 고정.
2. 법원코드는 `selectCortOfcLst.on`으로 받아오거나 §4.2 표를 상수로 박는다. `CourtRef.courtCode` = `cortOfcCd`.
3. `POST /pgj/pgjsearch/searchControllerMain.on` — §2.1 바디, `pageNo`만 증가시키며 순회.
4. **매 응답에 대해 순서대로 검사**:
   - 본문이 `{`로 시작하는가? 아니면 WAF HTML 차단 페이지 → 실패 처리 (HTTP 200이어도).
   - `data.ipcheck === true`인가? 아니면 로봇탐지 차단 → **즉시 순회 중단 + 장시간 백오프**.
   - zod로 `data.dlt_srchResult` 배열 스키마 검증 → 실패 시 spec의 "응답 형식 변경 감지" 경로.
5. 행 → 물건 접기: `(boCd, saNo, maemulSer)`로 group by, `address`는 §3의 `addrGbncd` 규칙.
6. 필수 필드(`jiwonNm`, `srnSaNo`, `maemulSer`) 누락 행은 제외 + 경고 로그 (spec 요구사항).
7. 페이지 간 최소 수 초 sleep. 동시 요청 금지.

---

## 8. Raw sample (**CONFIRMED** — 실제 응답, 1건만 발췌)

요청: 위 §2.1의 `body.json` (서울중앙지방법원, 2026-09-01 ~ 2026-10-31)

```json
{
  "status": 200,
  "message": "검색 결과가 조회되었습니다.",
  "timestamp": 1788675327824,
  "errors": null,
  "token": null,
  "data": {
    "dma_pageInfo": {
      "pageNo": 1, "pageSize": 10, "bfPageNo": 1, "startRowNo": 1,
      "totalCnt": "444", "totalYn": "Y", "groupTotalCount": 389
    },
    "ipcheck": true,
    "dlt_srchResult": [
      {
        "docid": "B0002102011013002849711",
        "boCd": "B000210",
        "saNo": "20110130028497",
        "maemulSer": "1",
        "mokmulSer": "1",
        "srnSaNo": "2011타경28497",
        "jpDeptCd": "1001",
        "jinstatCd": "0002100001",
        "mulStatcd": "01",
        "mulJinYn": "Y",
        "maemulUtilCd": "01",
        "mulBigo": "",
        "gamevalAmt": "711000000",
        "minmaePrice": "711000000",
        "yuchalCnt": "1",
        "maeAmt": "0",
        "inqCnt": "55",
        "gwansMulRegCnt": "8",
        "ipchalGbncd": "000331",
        "maeGiil": "20260908",
        "maegyuljGiil": "20260915",
        "maeHh1": "1000",
        "notifyMinmaePrice1": "711000000",
        "notifyMinmaePrice2": "0",
        "notifyMinmaePriceRate1": "100",
        "maeGiilCnt": "1",
        "ipgiganFday": "",
        "ipgiganTday": "",
        "maePlace": "경매법정(제4별관211호)",
        "hjguSido": "서울특별시",
        "hjguSigu": "성북구",
        "hjguDong": "정릉동",
        "daepyoLotno": "1032",
        "buldNm": "정릉2차 대주피오레",
        "buldList": "203동 4층 401호",
        "lclsUtilCd": "20000",
        "mclsUtilCd": "20100",
        "sclsUtilCd": "20104",
        "xCordi": "312690",
        "yCordi": "555963",
        "pjbBuldList": "철근콘크리트구조\n84.99㎡",
        "minArea": "84",
        "maxArea": "84",
        "dupSaNo": "2015타경14083<br/>2021타경102844",
        "byungSaNo": "",
        "jiwonNm": "서울중앙지방법원",
        "jpDeptNm": "경매1계",
        "tel": "530-1820 (제4별관 민사집행과)",
        "dspslUsgNm": "아파트",
        "convAddr": "[집합건물 철근콘크리트구조\n84.99㎡]",
        "printSt": "서울특별시 성북구 정릉동 1032 정릉2차 대주피오레 203동 4층 401호",
        "printCsNo": "서울중앙지방법원<br/>2011타경28497<br/>2015타경14083<br/>2021타경102844<br/>(중복)",
        "colMerge": "201101300284971"
      }
    ]
  }
}
```

같은 응답 10행 요약 (일괄매각으로 목적물 행이 늘어나는 것을 보여준다):

```
srnSaNo        maemulSer mokmulSer  maeGiil   yuchalCnt  dspslUsgNm                notifyMinmaePrice1
2011타경28497      1        1       20260908      1      아파트                       711,000,000
2024타경2501       1        1       20260910      3      다세대                       358,400,000
2024타경2532       1        1       20260915      5      기타                       1,800,732,000
2024타경2532       1        2       20260915      5      기타                       1,800,732,000
2024타경3528       1        1       20260922      2      상가,오피스텔,근린시설         180,480,000
2024타경3597       1        1       20260910      1      상가,오피스텔,근린시설       1,596,522,000
2024타경3597       1        2       20260910      1      상가,오피스텔,근린시설       1,596,522,000
2024타경3702       1        1       20260910      0      상가,오피스텔,근린시설       2,440,521,200
2024타경3702       1        2       20260910      0      상가,오피스텔,근린시설       2,440,521,200
2024타경3702       1        3       20260910      0      상가,오피스텔,근린시설       2,440,521,200
```
→ 행 10개 = 물건 5개. `totalCnt`(444) vs `groupTotalCount`(389)의 차이가 이것이다.

---

## 9. 구현 반영 메모 (task 3.2–3.5, 2026-09-06 실측)

3.1 조사 이후 **어댑터를 구현하면서 실제 호출로 새로 확인/정정된 것**만 적는다.
위쪽 §1~§8은 3.1 조사 시점의 기록이므로 아래 내용과 충돌하면 **여기가 최신**이다.

### 9.1 ★ `pageSize`에 상한이 있다 — 100은 HTTP 400 (**CONFIRMED**, 정정)

design.md D6은 "요청 수를 줄이려고 페이지 크기를 크게(기본 100행)"라고 적었지만,
`dma_pageInfo.pageSize = 100`으로 보내면 **HTTP 400**이 온다:

```json
{"timestamp":1788677144998,
 "errors":{"errorMessage":"사용에 불편을 드려서 죄송합니다. 잠시 후 다시 이용해 주십시오. ...",
           "errorCode":"","referedUrl":"/pgj/pgjsearch/searchController..."}}
```

같은 쿠키·같은 UA·같은 바디에서 `pageSize`만 바꿔 비교한 결과다:

| pageSize | 결과 |
|---|---|
| 10 | 200, 10행 |
| 40 | 200, 40행 |
| 100 | **400** |

UI가 제공하는 페이지 크기는 **10 / 20 / 30 / 40** 뿐이다
(PGJ151M01.xml L1251~1257의 `pgjUtil.setCookie('pageCnt', ...)`).
→ 어댑터는 `MAX_PAGE_SIZE = 40`을 상한으로 두고 기본값도 40으로 쓴다.

**요청량에 대한 함의:** 서울중앙 2개월 범위가 444행이므로 한 회차에
`1(index.on) + 12(페이지) = 13회` 요청이 나간다. §6.1의 "5분에 15회 미만으로도 차단"과
가까운 수치다 — 10분 주기 상시 운용이 지속 가능한지는 **여전히 미검증**이다.

### 9.2 페이지 2 이상 순회 성공 (**CONFIRMED**, §5의 UNVERIFIED 해소)

`pageNo=2, bfPageNo=1, totalYn:"N", totalCnt:444`로 보내 정상적으로 다음 40행을 받았다.
§5에 적힌 페이지네이션 규칙이 그대로 동작한다.

### 9.3 `bidBgngYmd`/`bidEndYmd`는 실제로 필터링에 반영된다 (**CONFIRMED**, §6.2 row 0 보강)

같은 조건에서 종료일만 바꿔 비교:

| 범위 | `totalCnt`(행) | `groupTotalCount`(물건) |
|---|---|---|
| 20260906 ~ 20261105 | 444 | 389 |
| 20260906 ~ 20260910 | 284 | 252 |

→ "진행 중"을 `bidBgngYmd = 오늘`로 표현하는 방식이 실제로 동작한다.
다만 이것이 사이트가 말하는 "진행중"과 같은 개념인지는 여전히 UNVERIFIED다
(수신 행은 전부 `mulJinYn="Y"`, `jinstatCd="0002100001"`).

### 9.4 `addrGbncd`는 실제 응답에 있다 (**CONFIRMED**, §8 발췌 보완)

§8의 raw sample 발췌에는 빠져 있었지만 실제 응답에는 존재한다.
page 1(40행) 분포: `R` 24행 / `A` 16행. §3의 주소 선택 규칙을 그대로 구현했다.

### 9.5 로봇탐지 차단 해제 시각 (§6.1 타임라인 연장, **CONFIRMED**)

| 시각(UTC) | 요청 | 결과 |
|---|---|---|
| 06:31:08 | `POST search` | ❌ `ipcheck:false` (3.1 조사 마지막 기록) |
| 06:44:15 | `GET /pgj/index.on` → `POST search` | ✅ `ipcheck:true`, 444건 |

→ **차단은 13분 초과 ~ 26분 이하 지속됐다.** §6.1이 추측한 "1시간 단위 차단"은
적어도 이번 사례에서는 **아니었다**. 그래도 정확한 해제 규칙을 모르므로 어댑터/워커의
기본 백오프는 보수적으로 1시간을 유지한다(`AUCTIONBOSS_COLLECT_BACKOFF_MS`로 조정).

### 9.6 구현이 채택한 판단 (근거는 코드 주석에도 있음)

- `status`는 소스 필드가 아니라 `yuchalCnt`에서 **파생**한다(`신건`/`유찰 N회`) — §3.1.
- `minBidPrice`는 `notifyMinmaePrice1` 우선, 0이거나 없으면 `minmaePrice`로 폴백.
- 행 접기 기준은 §7 step 5의 `(boCd, saNo, maemulSer)` 대신 도메인 자연키
  `(jiwonNm, srnSaNo, maemulSer)`를 썼다. 둘은 1:1이고, DB의 UNIQUE 키와 같은 기준으로
  접어야 한 배치 안에서 중복 키가 절대 생기지 않는다.
- 응답에 `data`가 아예 없는 경우는 `ipcheck` 검사보다 **먼저** 형식 오류로 처리한다.
  차단으로 오판하면 1시간 백오프에 잘못 들어가기 때문이다.
- 요청 바디에 `srchInfo: {}`를 포함한다. 프론트는 안 보내지만 §2.1의 "실제로 성공한
  요청"에 들어 있었고, 필수 여부가 분리 검증되지 않았으므로 성공 사례를 재현한다.

---

## 10. 물건 상세 화면 조사 (2026-09-07, 요청 2회)

목록 응답만 쓰는 현재 구현을 넘어 상세 데이터를 가져올 수 있는지 판단하기 위한 조사.
정적 화면 정의 XML만 GET 했고 검색 API는 호출하지 않았다. 차단 징후 없었다.

### 10.1 상세 엔드포인트 — **CONFIRMED** (XML 실물 + 2026-09-11 실측 호출)

§6.2 row 8의 추정이 **정확히 일치했다.**

```
POST /pgj/pgj15B/selectAuctnCsSrchRslt.on
요청 (dma_srchGdsDtlSrch): { csNo, cortOfcCd, dspslGdsSeq, pgmId: "PGJ15BM01" }
응답 바인딩: data.dma_result
```

2026-09-11 실측 프로브(사건: 2026타경101037, 서울중앙지방법원) 결과 **CONFIRMED**:
- `csNo`: 14자리 내부사건번호(`saNo`, 예: `"20260130101037"`)로 정상 조회됨 (**CONFIRMED**). 표시용 사건번호(`userCsNo`, 예: `"2026타경101037"`)는 응답의 `csBaseInfo.userCsNo`에 매핑되어 돌아온다.
- `cortOfcCd`: 법원코드(`boCd`, 예: `"B000210"`)로 정상 동작 (**CONFIRMED**).
- `dspslGdsSeq`: 빈 문자열(`""`)로 전송해도 필수값 누락 오류 없이 전체 물건/사진 목록이 정상 반환됨 (**CONFIRMED**). 별도 매핑이나 추가 파라미터 필요 없음.

`dma_result`의 키 구성 (**CONFIRMED**, `PGJ15BM01.xml` L56-71 및 실측 응답):
`csBaseInfo`(사건기본정보), `dstrtDemnInfo`(배당요구종기일), `dspslGdsDxdyInfo`(매각물건정보),
`picDvsIndvdCnt`/`csPicLst`(사진), `gdsDspslDxdyLst`(매각기일), `gdsDspslObjctLst`(매각목적물),
`rgltLandLstAll`(대지권토지), `bldSdtrDtlLstAll`(건물표제부), `gdsNotSugtBldLsstAll`(제시외건물),
`gdsRletStLtnoLstAll`(부동산소재지번), `aeeWevlMnpntLst`(감정평가요항표).

### 10.2 사진은 상세 응답에 base64로 이미 들어 있다 — **CONFIRMED** (2026-09-11 실측)

`csPicLst[i].picFile`이 이미지 URL이 아니라 **base64 이미지 원본**이다.
실측 일자: 2026-09-11, 실측 케이스: 2026타경101037 (서울중앙지방법원).

★ **실측 핵심 발견사항 (DERIVED → CONFIRMED 및 정정)**:
1. **이미지 포맷: PNG가 아닌 GIF89a**
   - XML(`PGJ15BM01.xml` L577)에는 `setSrc("data:image/png;base64," + csPicLst[i].picFile)`로 적혀 있었고, `picTitlNm`도 `"B000210202601301010371.jpg"`처럼 확장자가 `.jpg`로 표시되어 있으나,
   - 실제 base64 바이너리를 디코딩한 첫 6바이트 매직 바이트는 전부 `GIF89a`(base64 접두사: `R0lGODlh`)인 **GIF 포맷**이다.
   - 브라우저는 Data URL의 MIME 타입과 상관없이 실제 바이너리 매직 바이트를 보고 렌더링하므로 화면에서는 정상 표시되지만, 서버/로컬 파일시스템 저장 시 확장자를 `.gif`로 저장하거나 매직 바이트 기반으로 결정해야 한다.
2. **사진 장수 및 용량**:
   - 실측 케이스에서 총 **15장** 반환 (`csPicLst.length === 15`).
   - 장당 바이너리 크기: **100~200KB** (실측: 99KB ~ 203KB, 평균 약 136KB).
   - 물건당 사진 전체 바이너리 합계: 약 **2.04MB** (base64 인코딩 시 JSON 상에서 약 2.7MB).
   - 389건 전량 수집 가정 시 디스크 용량은 약 **800~850MB** 수준.

→ **사진을 받기 위한 추가 요청이 필요 없다.** 상세 응답 1회로 15장 전량이 base64로 한 번에 수신된다.
확대 팝업(`PGJ15BP06.xml`)도 이미 받은 데이터를 다시 보여주는 UI일 뿐 재조회하지 않는다.

### 10.3 권리관계·임차인·등기 데이터는 **없다** — **CONFIRMED (부재)**

`PGJ15BM01.xml` 전체에 임대차/전입/확정일자/가압류/근저당/선순위/말소기준을 담는
`dlt_*`/`dma_*`가 **하나도 없다.** 관련된 것은 `dstrtDemnInfo`(배당요구종기일) 단일 날짜값뿐.
"등기기록 열람" 버튼은 인터넷등기소 연계 **유료 외부 서비스** 팝업이며 JSON API가 아니다
(L2629 라벨에 명시).

**함의**: 경매 판단의 핵심인 권리분석 데이터를 이 소스로는 구조화된 형태로 얻을 수 없다.
AI 분석 품질에 이 소스만으로는 넘을 수 없는 상한이 있다. 필요하면 완전히 다른 데이터
소스(등기소 유료 API 등)를 찾아야 한다.

### 10.4 첨부 문서 — 각각 별도 호출이고 위험이 더 크다

- **감정평가서**: `POST /pgj/pgj15B/selectAeeWevlInfo.on`
  요청 `{cortOfcCd, cortSptNm, csNo, auctnInfOriginDvsCd, dspslDxdyYmd, pgmId, ordTsCnt}`,
  응답 `dma_ordTsIndvdAeeWevlInf` 안에 `pdfUrl`(실제 PDF 주소)이 있다 (**CONFIRMED**, `PGJ15BP03.xml`).
- **현황조사서**: `/pgj/ui/pgj100/PGJ15BP01.xml` (요청 안 해봄, **UNVERIFIED**)
- **매각물건명세서**: PDF를 직접 주지 않고 `POST /pgj/pgj15B/insertDspslGdsSpecArtcWdrwInf.on`
  응답의 `encParam`/`url`로 **외부 "소송문서뷰어"를 새 창으로 연다** (L1650-1666, **CONFIRMED** 소스상).
  암호화 파라미터(`encParam`, `pspTkn`, `pspSid`) 처리가 필요해 이 사이트 API 스펙만으로는
  구현 불가능할 가능성이 높다.

**★ 경고 (CONFIRMED — 코드 주석 원문)**: `PGJ15BP03.xml` 헤더에
```
2026.04.02.   강은숙   [26A-PGJ-0014] 현황조사서, 감정평가서 로봇차단솔루션 적용되게 개선
```
→ 이 두 문서 엔드포인트는 검색 API보다 **더 최근에, 별도로** 안티봇이 강화됐다.
검색 API 기준으로 잡은 레이트리밋이 여기에도 안전하다는 보장이 없다.
실제 임계값은 **UNVERIFIED**(이번 조사에서 POST 호출은 하지 않았다).

### 10.5 요청 수 재계산 (§6.1의 실측 차단 임계: 5분에 15회 미만)

| 시나리오 | 물건당 | 회차당(물건 389건) |
|---|---|---|
| 목록만 (현재 구현) | 0 | 13 |
| 상세 + 사진 | **+1** | **402** (임계의 약 27배) |
| + 감정평가서(JSON+PDF) | +2 | 800+ |
| + 현황조사서 | +1 이상 | — |
| + 매각물건명세서 | 미확정 + 외부 시스템 | — |
| 권리관계 | **불가능** | — |

### 10.6 판단

- **상세 + 사진은 현실적이다** — 물건당 1요청이므로, **수집 주기와 완전히 분리된 저속 큐**
  (물건당 수십 초 간격, 이미 가져온 물건은 재요청 안 함)로는 운용 가능하다.
  10분 주기 회차 안에 넣으면 즉시 차단된다.
- **감정평가서·현황조사서·매각물건명세서·권리관계는 권장하지 않는다.** 앞의 둘은 전용
  로봇차단이 더 강하고, 매각물건명세서는 외부 시스템이며, 권리관계는 애초에 존재하지 않는다.
- 감정평가서를 반드시 넣어야 한다면 **하루 이상 간격을 두고 `selectAeeWevlInfo.on`을 딱 1회만
  호출해 그 엔드포인트만의 차단 임계를 실측**하는 저강도 조사가 선행돼야 한다.

---

## 11. 확장 필드 확정 (enrich-item-fields task 1.1, 2026-09-08)

§3.1과 §8의 실제 응답, `__tests__/fixtures.ts`의 `REAL_ROW`(§8 raw sample을 그대로 옮긴
행)를 대조해 **실제 응답에 존재하는 것으로 확인된 필드만** 표로 정리한다. 이 표에
없는 필드는 어댑터에 매핑하지 않았다 — 아래 "포함하지 않은 필드"에 사유를 적는다.

`REAL_ROW`(§8 발췌, 실제 관측 1행) 기준 예시값. "의미 확인" 열은 그 필드의 **의미**가
확정됐는지를 뜻한다 — 필드가 실제로 오는 것(존재)과 그 값이 무엇을 뜻하는지(의미)는
별개다. 의미가 `미확인`인 필드는 domain 타입에 "코드표 미확인, 원문 보존" 주석과
함께 담되 해석하지 않는다(design.md D4).

| 소스 키 | 타입(문자열로 옴) | REAL_ROW 예시값 | 의미 확인 | domain 필드 |
|---|---|---|---|---|
| `minArea` | 숫자(㎡) | `"84"` | 확인(면적) | `minArea` |
| `maxArea` | 숫자(㎡) | `"84"` | 확인(면적) | `maxArea` |
| `pjbBuldList` | 문자열(줄바꿈 포함) | `"철근콘크리트구조\n84.99㎡"` | 확인(건물구조·면적 서술) | `buildingDescription` |
| `notifyMinmaePrice1` | 숫자(원) | `"711000000"` | 확인(1차 최저가) | `minBidPriceRound1` |
| `notifyMinmaePrice2` | 숫자(원) | `"0"` | 확인(2차 최저가, 0=미도래) | `minBidPriceRound2` |
| `notifyMinmaePrice3` | 숫자(원) | *(REAL_ROW엔 없음, §3.1 요약표에서 슬롯 확인)* | 확인(3차 최저가) — 필드 존재는 design.md D1이 "고정 4개 슬롯"으로 이미 전제한다 | `minBidPriceRound3` |
| `notifyMinmaePrice4` | 숫자(원) | *(위와 동일)* | 확인(4차 최저가) | `minBidPriceRound4` |
| `notifyMinmaePriceRate1` | 숫자(%) | `"100"` | 확인(1차 최저가율) | `minBidPriceRateRound1` |
| `notifyMinmaePriceRate2` | 숫자(%) | *(REAL_ROW엔 없음, §3.1 요약표에서 확인)* | 확인(2차 최저가율) | `minBidPriceRateRound2` |
| `lclsUtilCd` | 코드 문자열 | `"20000"` | **미확인**(코드표 없음) | `usageCodeLarge` |
| `mclsUtilCd` | 코드 문자열 | `"20100"` | **미확인** | `usageCodeMedium` |
| `sclsUtilCd` | 코드 문자열 | `"20104"` | **미확인** | `usageCodeSmall` |
| `hjguSido` | 문자열 | `"서울특별시"` | 확인 | `sido` |
| `hjguSigu` | 문자열 | `"성북구"` | 확인 | `sigungu` |
| `hjguDong` | 문자열 | `"정릉동"` | 확인 | `dong` |
| `daepyoLotno` | 문자열 | `"1032"` | 확인(대표지번) | `lotNumber` |
| `buldNm` | 문자열 | `"정릉2차 대주피오레"` | 확인(건물명) | `buildingName` |
| `buldList` | 문자열 | `"203동 4층 401호"` | 확인(동/층/호 상세) | `buildingUnit` |
| `xCordi` | 숫자 문자열 | `"312690"` | **미확인**(좌표계 EPSG 불명) | `coordinateX` |
| `yCordi` | 숫자 문자열 | `"555963"` | **미확인** | `coordinateY` |
| `cordiLvl` | 코드 문자열 | *(REAL_ROW엔 없음, §3.1 요약표에서 `"1"` 확인)* | **미확인**(좌표 수준 코드표 없음) | `coordinateLevel` |
| `maeHh1` | 문자열(HHmm) | `"1000"` | 확인(매각기일 시각, 콜론 없는 HHmm) | `auctionTime` |
| `maePlace` | 문자열 | `"경매법정(제4별관211호)"` | 확인(매각장소) | `auctionPlace` |
| `maegyuljGiil` | 문자열(YYYYMMDD) | `"20260915"` | 확인(매각결정기일) | `auctionDecisionDate` |
| `maeGiilCnt` | 숫자 | `"1"` | 확인(매각기일 회차) | `auctionRound` |
| `mulBigo` | 문자열 | `""`(REAL_ROW) / `"일괄매각"`(BUNDLE_ROWS) | 확인(비고) | `note` |
| `dupSaNo` | 문자열(`<br/>` 구분) | `"2015타경14083<br/>2021타경102844"` | 확인(중복 사건번호, 구분자 그대로 보존) | `duplicateCaseNo` |
| `byungSaNo` | 문자열 | `""` | 확인(병합 사건번호) | `mergedCaseNo` |
| `jpDeptNm` | 문자열 | `"경매1계"` | 확인(담당계 이름) | `courtDepartment` |
| `tel` | 문자열 | `"530-1820 (제4별관 민사집행과)"` | 확인(담당계 연락처) | `courtPhone` |
| `jinstatCd` | 코드 문자열 | `"0002100001"` | **미확인**(§3.1·§6.2 row 4에서 이미 UNVERIFIED로 기록) | `statusCode` |
| `mulStatcd` | 코드 문자열 | `"01"` | **미확인** | `itemStatusCode` |

### 포함하지 않은 필드 (판단 근거)

spec의 MODIFIED 요구사항이 나열한 카테고리에 없고, 화면·분석 어느 쪽에도 당장 쓸
곳이 없어 이번 change에서는 매핑하지 않는다. 나중에 필요해지면 §3.1 표에 이미 소스
키가 남아 있으므로 재수집 없이 추가할 수 있다.

- `inqCnt`(조회수), `gwansMulRegCnt`(관심등록수) — "인기도" 성격이라 spec의 정규화
  모델 카테고리(식별·면적·차수별가격·용도코드·소재지·좌표·매각·사건) 어디에도 안 들어간다.
- `maeAmt`(낙찰가) — 진행 중 물건 조회 범위에서는 관측값이 항상 `"0"`(미낙찰)이라
  실질적으로 쓸모가 없고, spec 카테고리에도 없다.
- `ipgiganFday`/`ipgiganTday`(기간입찰 시작·종료) — spec의 "매각 관련" 카테고리는
  기일입찰 정보(시각·장소·결정기일·회차)만 요구한다. 기간입찰 전용 필드라 범위 밖.
- `ipchalGbncd`(입찰구분) — 의미가 §6.2 row 3에서 이미 UNVERIFIED이고 spec 카테고리에도
  없다. 요청 파라미터로 이미 쓰는 `bidDvsCd`와 같은 계열의 코드로 보이나 확인되지
  않았다 — 근거 없는 필드를 추가하지 않는다(task 1.1 원칙).
- `docid`/`saNo`/`mokmulSer`/`boCd` — 행 접기(dedupe)용 내부 키다. 정규화 모델의
  자연 키(`court`/`caseNo`/`itemNo`)로 이미 대체되므로 도메인에 노출하지 않는다
  (기존 어댑터 코드가 이미 이렇게 다룬다).
- `wgs84Xcordi`/`wgs84Ycordi` — §3.1이 이미 "정수 단위라 사실상 쓸모없음"으로 기록했다.

### 판단 근거 메모

- `notifyMinmaePrice3`/`4`, `notifyMinmaePriceRate2`, `cordiLvl`은 `REAL_ROW`(§8 발췌
  1행)에는 나타나지 않는다 — §8은 "1건만 발췌"라고 명시했고 그 발췌 범위가 이 필드들을
  빼놓았을 뿐, §3.1의 별도 요약표(부가 필드)와 design.md D1("고정 4개 슬롯")이 이미
  이 필드들의 존재를 CONFIRMED로 기록해 뒀다. 테스트는 `REAL_ROW`를 변형한 합성 값으로
  이 경로를 검증한다(`adapter.test.ts`의 "차수별 3·4차..." 케이스) — `REAL_ROW` 자체는
  "§8을 그대로 옮긴 것"이라는 파일 상단 원칙을 지키기 위해 손대지 않았다.
- `minBidPriceRound1`(`notifyMinmaePrice1`)은 기존 `minBidPrice`(폴백 파생값)와 같은
  소스 필드를 읽는다 — 값이 겹치는 게 정상이다. `minBidPrice`는 "화면과 일치하는
  최종값"이고 `minBidPriceRound1`은 "1차 원값"이라는 서로 다른 목적이라 design.md D1이
  중복을 감수하고 둘 다 두기로 했다.
- `buildingUnit`(`buldList`)은 spec의 "소재지 구조화 값" 카테고리가 명시적으로 요구하는
  5개(시/도·시/군/구·동·대표지번·건물명)에는 없지만, NOTES §3의 같은 "소재지 분해" 표
  행에 있고 `address`(조합 문자열)만으로는 얻을 수 없는 동/층/호 단위 값이라 포함했다
  — 판단 근거는 구현 보고서 참조.

---

## 12. 전체 수집 실측 (2026-09-08) — **CONFIRMED**

프로젝트 최초로 서울중앙지방법원 **전체** 물건을 한 회차에 수집한 결과.
그 전까지는 항상 페이지 상한 1(요청 2회)로만 돌렸다.

### 12.1 실측 수치

| 항목 | 값 |
|---|---|
| 대상 | 서울중앙지방법원(B000210), 진행 중 물건 |
| 요청 페이지 수 | **12** (`pagesRequested`) |
| 총 요청 수 | **13** (세션 쿠키 1 + 검색 12) |
| 수신 행 수 | **443** (`totalCnt` 기준, §3.1의 "행 접기 주의" 참고 — 일괄매각 물건이 목적물 수만큼 행을 차지한다) |
| 수집 물건 수(접힌 후) | **389** |
| 회차 소요 시간 | **57초** (13:57:24 → 13:58:21 UTC) |
| 저장 결과 | `inserted=389, updated=0, changed=0` |
| 차단 | **발생하지 않음** |

§10.5의 예측(12페이지, 물건 389건)이 실측과 정확히 일치했다. 443행이 389물건으로
접힌 차이(54행)는 일괄매각 등으로 한 물건이 여러 목적물 행을 차지하는 경우다(§3.1,
`docid`/`saNo`/`mokmulSer` 기준 dedupe) — 데이터 손실이 아니라 설계된 접기 동작이다.
`updated=0, changed=0`은 첫 수집이므로 정상 — 갱신·변경 이력이 생기지 않는 것이
`add-price-change-history`가 보장한 동작이다.

### 12.2 ★ "10분 주기가 지속 가능한가" — 답: **예**

프로젝트 1단계부터 미해결로 남아 있던 질문의 실측 답이다.

핵심은 요청 **수**가 아니라 **밀도**다. 13요청이 **57초에 걸쳐** 나가고 그 뒤
**9분 이상 아무 요청도 없다**. §6.1에서 차단이 발생했을 때는 비슷한 규모의 요청이
훨씬 짧은 간격으로 몰렸다(조사 중 여러 엔드포인트를 연속 호출).

따라서 현재 설정(법원 1곳, `pageDelayMs` 기본값, 10분 주기)은 안전 범위로 보인다.
단서:

- **며칠 연속 운용은 아직 검증되지 않았다.** 이 실측은 1회차다. 누적 요청에 대한
  장기 임계가 따로 있을 가능성은 배제할 수 없다.
- **법원을 늘리면 이 결론이 그대로 적용되지 않는다.** `scale-collection-scheduling`의
  로테이션은 회차당 법원 수를 제한하므로 회차당 요청 밀도는 유지되지만, 한 바퀴
  주기가 길어져 데이터 신선도가 나빠진다(그 대가는 `/status`에 표시된다).
- 회차 기록(`worker_runs.pagesRequested`, 소요 시간)이 있었기에 이 답을 낼 수 있었다.
  그 필드는 한때 설정 상수를 기록하고 있었고 두 번에 걸쳐 실측값으로 고쳤다.

### 12.3 분석 처리량 실측 — **정정(2026-09-08, task 6.1)**

이전 버전은 "5회차·23건"으로 적혀 있었으나, `/tmp/ab-live.db`를 직접 세어 보면 실제로는
**6회차·28건**이다. 아래로 정정한다.

| 항목 | 값 |
|---|---|
| 분석 회차 | **6회** (`--once` 반복, 그중 1회는 중단됨 — 아래 참고) |
| 생성된 분석 | **28건** (물건 28개, 중복 없음) |
| 실패 | **0건** (개별 분석 단위로는 전부 성공 — 아래 "중단된 회차"는 회차 기록만 미완결이다) |
| 회차당 | 신규 5건(설정 한도와 일치). 마지막 회차만 3건에서 중단 |

**중단된 회차(`worker_runs.id=5`)**: 이 사이클을 실행하던 이전 에이전트가 분석 워커
프로세스를 회차 도중 직접 죽였다(과제 안내에 명시된 상황). 그 결과 `worker_runs`에
`outcome='running'`인 행이 하나 남아 있고 `finished_at`이 영원히 null이다. 그런데 그
회차가 이미 처리한 3건(물건 98/101/109)의 분석은 각각 개별 커밋이라 DB에 그대로
저장돼 있다 — "회차 기록의 완결"과 "그 안에서 처리한 개별 항목의 저장"이 별개라는
뜻이다. 이 남은 `running` 행은 인위적으로 만든 게 아니라 **실제로 죽은 워커가 남긴
고아 회차**이므로, `/status` 스테일 판정을 실데이터로 검증할 좋은 사례가 됐다
(live-data-and-reports task 5.1). 검증 결과: `getWorkerStatus`는 이 회차가 아니라
그 뒤에 성공한 더 최신 회차(6·7번)를 기준으로 상태를 판단하므로 analyzer 워커 전체는
정상(`ok`)으로 표시되고, 이 고아 행 자체는 "최근 회차" 목록에서 실행 경과 시간이 계속
늘어나는 "진행 중" 항목으로 남아 눈에 띈다 — 죽은 회차를 건강한 것처럼 숨기지도, 워커
전체를 죽은 것처럼 과대 판정하지도 않는다.

회차 5건(2·3·4·6·7번)에 3건(중단된 5번)을 더하면 5+5+5+3+5+5 = 28건, DB의 실제
analyses 건수와 정확히 일치한다.

389건을 전부 분석하려면 현재 한도(회차당 신규 5건)로 78회차 = 13시간이 걸린다.
이는 비용 통제를 위해 의도한 설계이지만, 초기 적재 시에는 별도 판단이 필요할 수
있다(예: 관심 물건 우선 분석).

### 12.4 스키마 결함 발견과 수정 (task 6.1)

이 사이클 도중 심각한 결함을 발견해 즉시 고쳤다(design.md D5의 "사용자에게 틀린
정보를 보여주는 결함" 예외 조항). `workers/lib/api.ts`의 `auctionItemSchema`(zod)가
`enrich-item-fields`에서 추가된 확장 필드 32개를 전혀 모르고 있었다. zod는 기본적으로
스키마에 없는 키를 조용히 버리므로(strip), 서버의 `GET /api/items` 응답에는
`minArea`/`minBidPriceRound1`/`note` 등이 실제로 들어 있는데도 analyzer가 파싱한
뒤에는 전부 `undefined`가 됐다 — `computeDerivedFigures`(면적당 가격·차수별 저감
추이)가 항상 "계산 불가"를 반환했고, 분석 프롬프트에 넘어가는 물건 JSON에도 이
필드들이 아예 없었다.

**영향 범위**: 이 수정 전에 생성된 분석 **23건**(§12.3의 id 1~23)이 전부 "면적 또는
최저매각가격 정보 없음" · "차수별 최저가 정보 없음"이라고 답했다 — 실제로는 값이
있는데도 없다고 말한 것이다. 수정 후 5건(id 24~28)부터는 실제 수치가 나온다. 예:
수정 전(item 115, 관악구 신림동) — "면적당 가격: 계산 불가 — 면적 또는 최저매각가격
정보 없음." 수정 후(item 137, 관악구 신림동, 같은 동네 유사 물건) — "면적당
최저매각가격은 21,533,333원/㎡이며, `minArea`(12㎡)와 `maxArea`(70㎡)가 서로 달라
면적이 범위로만 주어져 있어..." 수정은 코드 자체에 상세 주석으로 남겼다
(`workers/lib/api.ts` 33~90행 참고). 보고서 품질에 대한 추가 관측은 §13.

---

## 13. 분석 보고서 품질 관측 (2026-09-08, task 6.3) — 다음 사이클(cycle 9)이 근거로 쓸 것

`/tmp/ab-live.db`의 analyses 28건을 전부(§12.3) 읽고 유형별로 기록한다. **프롬프트는
고치지 않았다** — design.md D2/D5, 기록만 한다.

### 13.1 잘 작동한 사례 — 유지해야 할 것

- **유찰횟수 vs 가격 저감폭 불일치를 스스로 계산해서 지적한다.** 프롬프트가 이걸
  대놓고 요구하지 않는데도 모델이 `failedBidCount`(또는 `status`의 "유찰 N회")와
  `감정가 대비 최저매각가격 비율`을 대조해서 "통상 유찰 1회당 약 20% 저감" 규칙과
  어긋나면 지적한다. 표본 28건 중 **13건(46%)** 에서 이 지적이 나왔다(예: item 1 —
  "`failedBidCount`는 1회로 기록돼 있으나 최저매각가격이 감정가와 동일해(100.0%)
  통상적인 유찰 저감 패턴과 어긋난다"; item 115 — "유찰 7회가 매우 많은데 현재
  최저매각가격 비율은 80.0%(1회 저감 수준)에 그쳐 서로 어긋난다"). 이 불일치는
  cycle 8 이전에 이미 실제 데이터의 특성으로 확인된 것이라 모델이 데이터를 정확히
  읽고 있다는 신호다. 이후 사이클에서 프롬프트를 바꾸더라도 이 지적 능력은 후퇴시키지
  말 것.
- **일괄매각·중복사건 같은 부가정보를 놓치지 않고 엮는다.** item 158(동작구 사당동,
  일괄매각) 분석은 `note`의 "일괄매각" 값과 `duplicateCaseNo`를 함께 언급하며 "위
  면적·용도 표시는 목적물 전체가 아닌 일부만 반영한 값일 수 있다"고 정확히 경고했다.
  단순 수치 대입이 아니라 필드 간 관계를 실제로 읽고 있다는 증거다.
- **값이 서로 일치할 때도 그 사실을 명시한다**(item 158: "유찰횟수 0회와 최저매각가격
  비율 100%가 서로 일치해 신건 상태가 정합적으로 확인된다"). 불일치만 찾고 일치는
  침묵하는 게 아니라, 확인된 정합성도 문장으로 남긴다 — 읽는 사람이 "이 항목은 검토
  끝났다"고 신뢰할 수 있게 한다.
- **매번 동일한 "고지" 문단으로 데이터 범위의 한계(권리관계·임차인·등기 정보 없음)를
  분명히 한다.** 28건 전부에서 빠짐없이 나온다 — 이 프로젝트가 투자 조언이 아니라는
  법적/신뢰 경계를 지키는 데 중요하므로 반드시 유지할 것.

### 13.2 문제 — 유형별 기록

- **[사실 오류 아님, 그러나 오해 소지] 면적 데이터 손상(cycle 9 item 1 예정 결함)이
  "정상 범위"처럼 서술된다.** item 152(관악구 신림동, `minArea=179` > `maxArea=50` —
  손상된 186건 중 하나)의 분석은 "면적당 최저매각가격은 1,296,089원/㎡이다.
  `minArea`(179)와 `maxArea`(50)가 서로 달라 면적이 범위로 주어져 있다"라고만
  썼다. 이 문장은 **"179와 50이 다르다"까지만** 지적할 뿐, "min이 max보다 크다"는
  논리적으로 불가능한 상태(둘의 이름이 뒤바뀌었거나 원본 데이터가 손상됐다는 신호)는
  전혀 지적하지 않는다 — 마치 정상적인 면적 범위(예: item 137의 `12~70㎡`, item
  156의 `10~196㎡`, 둘 다 min<max로 정상)와 구분 없이 같은 어조로 서술한다. 계산에
  쓰인 분모(179)도 어느 쪽이 맞는 면적인지 모른 채 고른 값이라 결과 단가의 신뢰도가
  실제로는 낮다. **이 필드 자체를 고치는 것은 cycle 9 item 1의 몫**이지만, 그때
  프롬프트도 "min > max면 손상 의심"이라는 판단 기준을 명시하는 게 좋겠다 — 지금
  프롬프트는 이 이상 상태를 구분할 근거를 안 주고 있다는 뜻이다(기록만, 지금 안 고침).
- **[형식 문제] 라벨 서식이 회차마다 다르다.** 초반 분석들은 `**라벨** — 내용` 또는
  `**라벨**: 내용`(대시 vs 콜론)을 섞어 쓰고, 일부(item 91 등)는 라벨을 아예 굵게
  표시하지 않고 평문 단락으로만 쓴다(§4.1 파싱 결과 참고 — 굵게가 25/28 파일에만
  있다). 서식 일관성 자체가 사실 오류는 아니지만, 다음 프롬프트 개선 때 "항상 이
  형식" 같은 지시를 넣으면 화면 렌더링(4.1~4.4에서 만든 `AnalysisBody`)이 더 예측
  가능해진다.
- **[헛도는 문장 소지] 차수별 정보 없음을 매번 같은 문장으로 반복한다.** 차수별
  최저가(`minBidPriceRound2~4`)가 전혀 없는 물건(1차 매각 물건 다수)에서 "차수별
  저감 추이: 1차만 존재해 아직 저감이 발생하지 않았다"는 문장이 거의 그대로
  반복된다. 사실이라 틀린 건 아니지만, 정보값이 낮다 — 이런 물건은 애초에 이
  섹션을 생략하거나 한 문장으로 합치는 게 더 나을 수 있다(기록만, 이번엔 프롬프트를
  안 고친다).

### 13.3 §12.4 스키마 결함과의 관계

§12.4의 결함(확장 필드 32개가 zod에서 strip됨)은 §13.2의 문제들과는 별개다 — 그
결함은 "값이 있는데 없다고 말함"(사실 오류)이었고, 수정 후에는 그 오류가 사라졌다.
남은 §13.2 문제들은 스키마 결함과 무관하게 **수정 후에도 남아 있는** 프롬프트
수준의 개선 여지다.

---

## 14. 연속 운용 실측 + 재분석 경로 첫 실증 (hardening-round2, 2026-09-08/09) — **CONFIRMED**

§12는 "1회차"였다. 이번이 프로젝트 최초로 **서버+수집기+분석기를 동시에 상주시켜
자동 반복 회차**를 관측한 기록이다(design.md D1). 실측 DB는 `/tmp/ab-live.db`의
스크래치 복사본이었다 — 원본은 건드리지 않았다(수집·분석·워커 회차 실측용 복사본과,
재분석 실증용 복사본을 따로 뒀다).

### 14.1 조정한 값과 원복

| 값 | 원래 | 조정 | 방법 | 원복 여부 |
|---|---|---|---|---|
| 수집 범위(매각기일 범위) | 60일 | 4일 | `AUCTIONBOSS_COLLECT_BID_WINDOW_DAYS=4`(env, 프로세스 한정) | 해당 없음 — 파일을 안 건드림 |
| 수집 주기 | 600000ms(10분) | **그대로 둠** | — | — |
| `observability.maxRunsPerWorker` | 1000 | 5 | `config/collector.json` 직접 수정 | ✅ 관측 종료 후 1000으로 복원, `git diff` 빈 것으로 확인 |
| `analysis.reanalysisCooldownHours`(재분석 실증 전용, 아래 14.3) | 24 | 1 | `config/collector.json` 직접 수정 | ✅ 24로 복원, 복원 후에도 쿨다운이 다시 걸리는 것까지 재확인 |

수집 범위만 좁히고 주기는 그대로 뒀다 — 요청 **밀도**(§12.2의 안전 근거)를 그대로
지키면서 회차를 가볍게 하기 위함이다(design.md D1). 4일 범위는 4페이지·144행·128물건,
회차당 요청 5회(세션 1 + 페이지 4)로 §12의 60일·13요청보다 훨씬 가볍다.

### 14.2 연속 운용 결과

**약 15분 동안 자동으로 돈 결과**(중간에 아래 14.4의 고의적 kill 테스트 포함):

| 항목 | 값 |
|---|---|
| 실제 수집 회차(성공) | 4회 — 매 회차 5요청(세션+4페이지), 각 15.8~16초, `changed=0`(실제 필드 변경 없음) |
| 중첩 방지로 건너뛴 회차 | 1회 — `tick()`을 의도적으로 겹쳐 호출해 실제 네트워크·실제 코드 경로에서 확인(아래 참고). `worker_runs`에 `outcome='skipped', error_kind='overlap'`으로 기록되고 `/status` 화면에도 그대로 노출됨 |
| 차단(`ipcheck:false`, WAF, RobotDetectedError) | **0건 — 전체 관측 동안 한 번도 발생하지 않음** |
| 실제 사이트 요청 수(이 관측 전체) | 약 25회(overlap 테스트 1회의 5요청 포함 20 + overlap 스킵 자체는 0요청 + 사전 확인용 1회 5요청) — §6.1의 "5분에 15회" 임계에 전혀 근접하지 않음 |
| 분석 회차(성공) | 2회 — 각 신규 5건, 회차당 약 1분 45초~55초 |
| 분석 대기열 감소 | 361 → 356 → 351건(자동 회차 2번 동안 실제로 줄어드는 것을 확인) |
| 실제 Claude 호출 수(이 관측 전체) | 12건(연속 운용 신규분석 10건 + 재분석 실증 2건, 아래 14.3) — 고의적 kill로 중단된 회차(14.4)는 로그상 "저장 완료"가 0건이라 완료된 호출은 없었다 |
| 보관 상한(`maxRunsPerWorker=5`) 실제 작동 | ✅ collector·analyzer 둘 다 — 회차가 5건을 넘어서자 가장 오래된 행부터 실제로 삭제됨(아래 14.4) |

**중첩 방지 실증 방법**: `startCollector()`가 반환하는 `tick()`을 `await` 없이 두 번
연달아 호출했다(`workers/collector.ts`의 실제 `AuctionSource`, 실제 네트워크). 첫 번째만
실제로 수집했고(5요청, 15.9초, 128건), 두 번째는 `"[collector] 이전 회차가 아직
실행 중이라 이번 주기를 건너뜁니다"` 로그와 함께 즉시 반환됐다 — 네트워크 요청은
전혀 추가되지 않았다. 이건 기존에 fake source로 단위 테스트된 로직이지만, **실제
네트워크·실제 DB로 확인한 것은 이번이 처음**이다.

**10분 주기가 "며칠 연속"에도 안전한가 — 이번에도 답하지 못한다.** 이번 실측은
~15분·법원 1곳·2 워커 동시 상주다. §12.2가 답한 "요청 밀도" 질문은 다시 확인됐지만
(요청이 짧게 몰리고 그 뒤 비어 있는 패턴은 4일 범위에서도 동일), **누적 요청에 대한
장기 임계가 있는지는 이번 실측 범위(15분)로는 알 수 없다.** 이걸 알려면 실제로
며칠 동안 띄워 두고 `worker_runs`가 차단을 기록하는지 지켜보는 것 외에 다른 방법이
없다 — 코드는 이미 필요한 걸 다 기록한다.

### 14.3 재분석 경로 첫 실증 (design.md D2)

`maxReanalysisPerRun`·`reanalysisCooldownHours`는 후보가 없어(item_changes가 전부
`kind='baseline'`) 이 프로젝트가 생긴 이래 실데이터로 단 한 번도 실행되지 않았다.
자연 발생(유찰)을 기다리면 몇 주 걸리므로, 이미 분석된 물건(id=1, 2011타경28497,
첫 분석 2026-09-08T13:59:31Z)의 감시 필드를 실제 `upsertItems()` 경로로 직접
바꿨다 — `failedBidCount` 1→2, `minBidPrice` 20% 저감, `status` "유찰 1회"→"유찰
2회". `upsertItems`가 실제로 `item_changes`에 `kind='change'` 행 3개를 만든 것을
확인했다(수집기가 실제로 값이 바뀐 물건을 다시 수집했을 때와 동일한 코드 경로).

- **쿨다운(기본 24시간, 설정 변경 없이 확인)**: 이 시점 실제 경과 시간은 약 4시간뿐이라
  `GET /api/items?needsAnalysis=true`가 이 물건을 후보로 돌려주지 **않았다** — 구조적으로는
  후보 조건(분석 존재 + 실제 변경 있음)을 만족해도 쿨다운이 막는 것을 기본값 그대로 확인.
- **쿨다운을 짧게 조정해 후보 등장 확인**: `reanalysisCooldownHours`를 1로 낮추고 서버를
  재기동하자(설정은 프로세스 시작 시 1회 읽고 캐시하므로 재기동 필요) 같은 물건이 즉시
  후보 목록에 나타났다.
- **실제 재분석 실행**: `AUCTIONBOSS_ANALYZE_MAX=1 AUCTIONBOSS_ANALYZE_REANALYZE_MAX=1`로
  analyzer를 1회 실행 — 신규 미분석 물건(id=165, 처음 분석됨)과 재분석 대상(id=1)이
  **같은 회차에** 함께 처리됐다(미분석 물건이 남아 있어도 재분석이 밀려나지 않는다는
  설계가 실증됨). id=1의 **이전 분석(id=1, 517자)은 그대로 남았고**, 새 분석(id=30,
  851자)이 추가로 생겼다 — 새 분석은 바뀐 값을 정확히 반영했다("유찰 2회", "80.0%",
  유찰횟수-저감률 불일치까지 스스로 지적).
- **재분석 직후 쿨다운 재확인**: 같은 물건을 곧바로 또 바꾼 뒤(item_changes에 `change`
  행 2개 추가, 누적 5건) 같은 쿨다운(1시간) 아래 다시 조회하니 — 방금 재분석됐으므로
  —후보 목록에서 **빠졌다**(정확히 원하던 "쿨다운이 막는다" 확인).
- **설정 복원 후 재검증**: `reanalysisCooldownHours`를 24로 되돌리고 서버를 재기동한 뒤
  다시 조회 — 여전히 후보 목록에서 빠짐(복원된 기본값 아래서도 정상적으로 막힘을 재확인).
  `git diff config/collector.json`으로 파일이 원래 상태임을 확인.
- **부가 확인**: 쿨다운으로 막혀 자동 재분석은 안 됐어도, 물건 상세 화면의 분석
  최신성 배지는 정확히 "갱신 예정"(stale)으로 표시됐다 — 쿨다운이 "최신"으로
  잘못 보이게 하지 않는다(design.md D3의 우려가 실제로 방지되는 것 확인).

### 14.4 고아 `running` 회차 행 — 연속 운용에서 재현

cycle 10은 이전 세션이 분석 워커를 죽이며 우연히 고아 행(`worker_runs.id=5`,
2026-09-08T14:01:38Z 시작, 영원히 `running`)을 하나 만들었다. 이번 사이클은 **그
현상이 연속 운용 중에 다시 만들어지는지**를 직접 실험했다 — analyzer가 새 회차를
시작한 직후(`"신규 5건... 분석 시작"` 로그 직후) `SIGKILL`로 강제 종료했다.

결과: `worker_runs.id=13`이 `outcome='running', finished_at=NULL`로 영구히 남았다
(이번엔 로그상 완료된 항목이 0건 — cycle 10 사례는 3/5건이 이미 저장된 뒤 죽었는데,
이번엔 첫 항목 처리 전에 죽어 저장된 분석은 하나도 없었다. 두 경우 다 "회차 기록
미완결"과 "그 안에서 실제로 끝낸 개별 분석의 저장"이 분리돼 있다는 설계를 그대로
보여준다). `getWorkerStatus`는 이번에도 이 고아 행이 아니라 이후 성공한 최신 회차를
기준으로 판단해 워커 전체 상태는 `ok`로 정확히 유지됐다.

**보관 상한이 오래된 고아 행도 정리한다는 것도 이번에 처음 확인했다**: 관측이 끝날
때 analyzer의 `worker_runs`를 보니 cycle 10의 원래 고아 행(id=5)이 **더 이상 없었다**
— `maxRunsPerWorker=5` 아래서 이후 회차(11, 13, 14)가 쌓이며 `started_at` 기준으로
오래된 순서(id=2,3,4,5)가 차례로 밀려났다. 정리 기준이 `outcome`이 아니라
`started_at`이므로 고아 행도 예외 없이 밀려난다 — 다만 그동안(밀려나기 전까지)은
"최근 회차" 목록에 실행 경과 시간이 계속 늘어나는 항목으로 계속 보인다. 이번에
새로 만든 고아 행(id=13)은 관측 종료 시점에는 아직 보관 상한 안에 남아 있었다(관측을
너무 일찍 끝내서 밀려나는 것까진 못 봤다 — 다음에 이어서 볼 사람을 위해 남겨 둠).

### 14.5 요약 — 이번에 답한 것과 여전히 못 답한 것

**답함**: 짧은(15분) 연속 운용에서 중첩 방지·보관 상한·재분석(신규 우선·쿨다운
차단/해제)·고아 행 처리가 전부 설계대로 동작한다. 실제 사이트 요청은 이 관측
전체에서 25회에 그쳤고 차단은 없었다.

**여전히 못 답함**: 며칠 단위 연속 운용, 다법원 확장, 실제 소스 노이즈(가짜 변경)
발생 빈도 — 셋 다 "더 오래, 또는 다른 조건으로 실제로 돌려 보는 것" 외에 다른
검증 방법이 없다. 이번 사이클이 준 것은 정확한 측정 인프라(`worker_runs`,
`pagesRequested`, `changed`)뿐이고, 그 인프라로 답을 얻으려면 시간이 더 필요하다.

---

## 15. 상세 조회 식별자 매핑 (add-item-photos stage A, 2026-09-11)

§10.1의 상세 엔드포인트(`selectAuctnCsSrchRslt.on`)는 `{csNo, cortOfcCd, dspslGdsSeq}`를
요구한다. 이 셋을 검색 응답 행의 필드와 대응시키는 작업(추가 HTTP 요청 0건, 코드 변경만).
**새로 호출을 보내 확인한 것은 없다** — §2.2/§3.1/§11의 기존 CONFIRMED/DERIVED 표기를
그대로 인용한다.

### 15.1 `csNo` ↔ `saNo` — DERIVED (정황 근거, 미검증)

검색 요청 자체의 필터 파라미터 목록(§2.2)에 이미 `csNo`가 있고("사건번호"), 응답 행의
`saNo`("내부 사건번호")가 그 값을 돌려주는 것으로 보인다 — 같은 개념을 요청/응답 양쪽에서
같은 문자열로 부르는 흔한 패턴이다. 다만 **실제 상세 요청으로 `saNo` 값을 `csNo`에 넣어
호출해 본 적은 없다** — stage B가 확정해야 한다.

domain 필드명은 `internalCaseNo`로 뒀다. **`case_no`(표시용 `srnSaNo`, 예:
`"2011타경28497"`)와 같은 값인지는 여전히 UNVERIFIED다** — 형식부터 다르다(`saNo`는
`"20110130028497"`처럼 순수 숫자열). `case_no`를 재사용하지 않고 별도 컬럼
(`internal_case_no`)에 원문 그대로 저장한다.

### 15.2 `cortOfcCd` ↔ `boCd` — DERIVED (정황 근거, 미검증)

검색 요청 바디의 `dma_srchGdsDtlSrchInfo.cortOfcCd`(§2.2)가 이미 법원코드 파라미터고,
응답 행의 `boCd`가 같은 코드 체계(`"B000210"` 형식, §4.1)다. 검색 요청 자체가 이 값을
그대로 왕복시키는 구조라 `csNo`/`saNo`보다는 신뢰도가 조금 높지만, 이것도 상세 엔드포인트로
직접 검증된 적은 없다.

domain 필드명은 `courtCode`로 뒀다.

### 15.3 `dspslGdsSeq` — **대응 필드 미확인, 매핑하지 않음**

NOTES.md 전체를 다시 훑었다 — §2.2(검색 요청 파라미터 전체 목록), §3.1(필드 매핑표),
§11(확장 필드 확정표) 중 어디에도 검색 응답 행의 필드가 `dspslGdsSeq`에 대응한다는
근거가 없다. `dspslGdsSeq`라는 이름 자체가 언급되는 곳은 상세 엔드포인트의 요청
파라미터 이름을 나열하는 §2.2/§6.2/§10.1 세 곳뿐이고, 셋 다 검색 응답 필드와 연결짓지
않는다.

이름으로 추측하면 `maemulSer`(물건번호, item 단위)나 `mokmulSer`(목적물번호, 일괄매각의
개별 목적물 단위)가 후보다. 하지만:
- 물건당 1요청(proposal.md 전제)이 맞다면 물건 단위 식별자(`maemulSer`)일 가능성이
  높은데, 그건 이미 `itemNo`로 저장되고 있어 새 필드가 딱히 필요 없다는 뜻이 된다.
- `mokmulSer`라면 일괄매각 물건은 목적물마다 다른 값을 가지므로 물건 하나에 여러
  상세 요청이 필요하다는 뜻이 되어 "물건당 1요청" 전제와 충돌한다.

두 후보가 서로 다른 결론(스킵 가능 vs. 추가 요청 필요)으로 갈리는데 이름 유사성 외에는
아무 근거가 없다 — 여기서 하나를 찍어 코드에 넣으면 stage B가 **틀린 값으로 상세 요청을
보내면서도 그 사실을 눈치채지 못할 수 있다**(요청 자체는 200으로 응답할 가능성이 높고,
엉뚱한 물건의 상세를 받아와도 파싱은 성공한다). 그래서 이 change에서는 domain 모델에
`dspslGdsSeq`에 대응하는 필드를 **추가하지 않았다**(NOTES §11 "포함하지 않은 필드"의
원칙 — 근거 없는 필드를 추가하지 않는다 — 을 그대로 따름).

**stage B가 반드시 먼저 할 일**: 실제 상세 요청 1건을 보내기 전에, 이 값이 무엇인지부터
정해야 한다. 가장 안전한 방법은 `dspslGdsSeq`를 생략하거나 빈 값으로 보내 서버가 필수
파라미터 누락 오류를 돌려주는지 확인하는 것 — 에러 메시지가 힌트를 줄 수 있다. 그래도
안 되면 `maemulSer`/`mokmulSer` 중 하나로 추정 호출하되, 받은 `dma_result.csBaseInfo`
등에서 사건번호·물건번호가 요청한 물건과 실제로 일치하는지 반드시 대조해야 한다(엉뚱한
물건의 상세를 받고도 "성공"으로 착각하지 않기 위함).

### 15.4 구현 반영

- `src/lib/domain/types.ts`: `AuctionItemInput.internalCaseNo`(← `saNo`),
  `AuctionItemInput.courtCode`(← `boCd`) 추가. 둘 다 optional + `| null`(§11 확장 필드와
  같은 이유 — `workers/**`의 기존 리터럴이 이 필드를 몰라도 계속 컴파일되어야 한다).
- `src/lib/sources/courtauction/adapter.ts`: `toItem()`에서 매핑. `saNo`/`boCd`는
  `schema.ts`에 이미 선언돼 있었다(행 접기 dedupe 키로 쓰던 필드라 이번에 새로 추가한
  것은 zod 스키마가 아니라 domain 매핑 쪽이다). `EXTENDED_FIELD_KEYS`(§11 확장 필드
  묶음이 통째로 사라지는 것을 감지하는 경고용 목록)에는 **포함하지 않았다** — 이
  둘은 §11보다 훨씬 이전부터 존재한 핵심 dedupe 필드라 성격이 다르고, 넣으면
  `NO_EXTENDED_FIELDS_ROW` fixture(saNo/boCd는 있고 §11 필드만 없는 고정 시나리오)에서
  "확장 필드가 전부 비었다" 경고 테스트가 깨진다.
- `src/lib/db/schema.ts` / `client.ts` / `repository.ts`: `items.internal_case_no`,
  `items.court_code` 컬럼 추가 + 기존 DB 파일 마이그레이션(`migrateItemDetailIdentifierColumns`).
- `workers/lib/api.ts`: `auctionItemSchema`(zod)에도 두 필드를 추가했다 — 이 파일의
  `KeysEqual` 컴파일타임 단언(§12.4에서 발견된 "32개 필드가 zod에서 조용히 strip되던"
  결함의 재발 방지 장치)이 없으면 `npx tsc --noEmit`을 실패시키기 때문이다. 워커가 이
  두 필드를 실제로 쓰는 로직은 없다 — 여전히 stage A의 범위는 `src/lib/**`뿐이고, 이건
  기존 가드를 통과시키기 위한 최소 선언일 뿐이다.
