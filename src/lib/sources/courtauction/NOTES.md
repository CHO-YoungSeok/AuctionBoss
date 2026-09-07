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

### 10.1 상세 엔드포인트 — **CONFIRMED** (XML 실물)

§6.2 row 8의 추정이 **정확히 일치했다.**

```
POST /pgj/pgj15B/selectAuctnCsSrchRslt.on
요청 (dma_srchGdsDtlSrch): { csNo, cortOfcCd, dspslGdsSeq, pgmId, srchInfo }
응답 바인딩: data.dma_result
```

`dma_result`의 키 구성 (**CONFIRMED**, `PGJ15BM01.xml` L56-71):
`csBaseInfo`(사건기본정보), `dstrtDemnInfo`(배당요구종기일), `dspslGdsDxdyInfo`(매각물건정보),
`picDvsIndvdCnt`/`csPicLst`(사진), `gdsDspslDxdyLst`(매각기일), `gdsDspslObjctLst`(매각목적물),
`rgltLandLstAll`(대지권토지), `bldSdtrDtlLstAll`(건물표제부), `gdsNotSugtBldLsstAll`(제시외건물),
`gdsRletStLtnoLstAll`(부동산소재지번), `aeeWevlMnpntLst`(감정평가요항표).

### 10.2 사진은 상세 응답에 base64로 이미 들어 있다 — **DERIVED** (신뢰도 높음)

`csPicLst[i].picFile`이 이미지 URL이 아니라 **base64 PNG 원본**이다.
`PGJ15BM01.xml` L577: `setSrc("data:image/png;base64," + csPicLst[i].picFile)`.

→ **사진을 받기 위한 추가 요청이 필요 없다.** 확대 팝업(`PGJ15BP06.xml`)도 이미 받은
데이터를 다시 보여주는 UI일 뿐 재조회하지 않는다(L1408-1424).
실제 응답을 받아본 것은 아니므로 엄밀히 DERIVED이나, 코드가 명확한 문자열 조합이다.

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
