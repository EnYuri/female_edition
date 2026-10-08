# Female_edition_by_Female-cupwhi_by_EnYuri

야생암컷에마님을 두려워 하는.

# ♀️ 어두운 에마님 진실 ♀️

AI 활용으로 작성된 모독적인 모듈.

## 사용 설명서

### 설치와 첫 설정

Female-cupwhi는 Foundry Virtual Tabletop v13·v14용 모듈입니다. 채팅, 화면 표시, 전투, 이미지, 음악 기능을 한곳에서 설정할 수 있습니다. 여러 게임 시스템에서 사용할 수 있지만 D&D 5e, DX3rd 등 시스템 전용 기능은 해당 시스템에서만 동작합니다.

1. Foundry의 **애드온 모듈 설치**에서 아래 매니페스트 주소를 입력해 설치합니다. 수동 설치라면 이 저장소를 `'Data/modules/'`에 놓습니다.
   [최신 릴리스 매니페스트](https://github.com/EnYuri/female_edition/releases/latest/download/module.json)
2. 월드의 **모듈 관리**에서 **Female-cupwhi**를 켜고 월드에 접속합니다.
3. **게임 설정 → 모듈 설정 → Female-cupwhi: 통합 설정 패널 → 설정 열기**에서 원하는 기능을 조정하고 저장합니다. 메뉴는 일반, 채팅 기능·외형·병합, 포트레이트, 아카이브, 인터페이스, 이미지, 음악, 컴뱃 트래커, 무대 채팅, 토큰·패널 탭으로 나뉩니다.

일부 설정은 저장 후 새로고침이나 월드 재접속이 필요합니다. 모듈을 처음 설치하거나 업데이트한 직후에는 월드에서 나갔다가 다시 들어와 새 매니페스트와 스크립트를 불러오세요.

### 글꼴과 화면 테마

**일반 → 폰트**에서 **커스텀 폰트 적용**을 켠 뒤 기본 제공 글꼴을 고를 수 있습니다. 컴퓨터에 설치된 글꼴이나 모듈의 `font/` 폴더에 넣은 글꼴을 쓰려면 **유저(로컬) 폰트 사용**을 켜고 목록에서 고르거나 글꼴 이름을 직접 입력하세요. **시스템 폰트 불러오기**는 브라우저의 로컬 글꼴 접근 권한을 요청할 수 있습니다. 같은 탭에서 토큰 이름표·커서와 그리기·지도 노트의 글꼴 적용도 따로 조절합니다.

**일반 → 레트로 테마**는 창과 UI를 각진 픽셀풍으로 바꿉니다. 글꼴과 테마는 각각 켜고 끌 수 있습니다.

### 채팅

- **마크다운과 편집:** 채팅 기능 탭에서 마크다운과 메시지 편집을 켤 수 있습니다. 예를 들어 `**굵게**`처럼 입력하면 서식이 적용됩니다. 수정 권한이 있는 메시지의 연필 아이콘이나 메뉴에서 **메시지 수정**을 누르세요. 편집 창에서는 마크다운 원문과 HTML 원문을 전환할 수 있습니다. `Enter`는 저장, `Shift+Enter`는 줄바꿈, `Esc`는 취소입니다.
- **연속 메시지 병합:** 채팅 병합 탭에서 같은 화자의 연속 메시지를 한 묶음으로 표시합니다. 병합 기준을 토큰·액터·플레이어 중에서 고르고, 주사위 메시지와 채팅 카드 포함 여부, 이름·포트레이트 표시 방식을 조절할 수 있습니다.
- **포트레이트와 외형:** 포트레이트 탭에서 채팅 초상화의 크기·모양·표시 대상을 정합니다. 채팅 외형 탭에서는 배경 텍스처, 사용자 색상, 글자 크기와 간격 등을 조절합니다.
- **이미지 보내기:** 채팅 입력창의 **이미지 업로드** 버튼을 사용하거나 이미지를 채팅 입력창에 붙여넣기·드롭하세요. 업로드 버튼이 보이지 않으면 채팅 컨트롤의 메뉴를 열어 확인하세요. 준비된 이미지 목록에서 전송할 수 있습니다. 이미 서버에 있는 이미지 파일은 `!ci|이미지/경로.webp!`처럼 적어 채팅에 삽입할 수 있습니다. 채팅 속 이미지를 클릭하면 크게 볼 수 있습니다. 직접 업로드 권한이 없는 플레이어는 온라인 GM을 통해 업로드하며, 실패하면 메시지에 직접 포함하는 경로가 사용될 수 있습니다.
- **타이핑 알림과 채팅 정리:** 채팅 기능 탭에서 다른 사람의 입력 중 표시와 채팅 DOM 정리를 조정합니다. DOM 정리는 화면에 남겨 둘 메시지 수를 제한해 긴 채팅의 부담을 줄입니다. 오래된 메시지를 월드 데이터에서 삭제하는 기능은 아닙니다.

### 채팅 아카이브 저장

1. 채팅 컨트롤 메뉴의 **채팅 로그 내보내기(PDF/HTML)** 버튼을 누릅니다.
2. 전체 로그 또는 메시지 범위를 선택합니다. 범위 번호는 가장 오래된 메시지가 1번입니다.
3. 웹 브라우저에서는 열린 아카이브에서 **HTML 저장** 또는 **인쇄 / PDF**를 선택합니다. Foundry 데스크톱 앱에서는 HTML 아카이브를 저장한 뒤 Chrome 또는 Edge로 열어 **인쇄 → PDF로 저장**하세요.

아카이브 탭에서 이미지·폰트 포함, PDF 출력용 이미지 품질, 귓속말 제외 등을 설정합니다. GM이 저장할 때 귓속말 제외를 끄면 GM에게 보이는 비공개 대화도 아카이브에 들어갈 수 있으므로 저장 전에 확인하세요.

### 무대 채팅과 내레이터

- **무대 채팅:** 액터 시트 머리말이나 액터 디렉터리 메뉴의 **무대에 추가**로 캐릭터를 무대에 올립니다. 채팅창의 무대 선택 메뉴에서 발화자를 고른 뒤 평소처럼 메시지를 보내면 포트레이트와 대사창에 표시됩니다. 감정 선택, 이전 발화 불러오기, 대사창 닫기 버튼을 사용할 수 있습니다. 액터의 **무대 설정**에서 표시 이름·기본 포트레이트·감정별 이미지를 지정합니다.
- **내레이터:** 채팅 입력창에서 `/narrate 내용`은 화면의 시네마틱 내레이션과 채팅 메시지를 띄웁니다. 이 명령에는 설정 수정 권한이 필요합니다. `/describe 내용`은 묘사 메시지, `/note 내용`은 GM에게 보내는 알림 메시지입니다. `/as 이름`은 이후 일반 채팅의 별칭을 지정하고, `/as`만 입력하면 해제합니다. 명령어는 영문이며 각 명령의 최소 사용자 역할은 무대 채팅 탭에서 GM이 정합니다. 무대 발화자가 선택된 동안에는 무대 발화가 일반 별칭보다 우선합니다.

### 이미지, 토큰, 스크린 패널

- **이미지 호버:** 이미지 탭에서 켜면 토큰에 마우스를 올렸을 때 캐릭터 아트를 크게 표시합니다(x키를 누르고 있는 동안). 표시 위치·크기·지연 시간, 사용할 이미지와 최소 권한을 설정할 수 있습니다.
- **파일 선택기:** 인터페이스 탭의 확장을 켜면 선택한 파일의 미리보기와 이름·날짜·크기 정렬을 사용할 수 있습니다. 업로드 권한이 있는 사용자가 이미지 파일을 드롭하거나 붙여넣으면, **파일 픽커: 현재 폴더에 이미지 업로드** 설정(기본 ON)에 따라 **현재 열어 둔 폴더**에 저장하고 업로드한 이미지를 선택합니다. 업로드 불가능한 폴더에서는 오류를 표시합니다. GM이 이 설정을 OFF로 바꾸면 기존처럼 **파일 픽커 외부 이미지 업로드 경로**(기본 `uploaded-filepicker-images`)에 모아 저장합니다. 채팅 이미지 업로드 경로와는 별개입니다.
- **토큰 설정 미리보기:** 인터페이스 탭에서 켜면 프로토타입 토큰 설정 창에서 이미지·크기·앵커를 격자 위에 미리 보여 줍니다. 같은 탭에서 나머지 토큰 설정 탭의 2열 배치도 선택할 수 있습니다.
- **토큰 표시:** 토큰·패널 탭에서 선택·호버·타겟 글로우, 타겟 조준선, 액터 이름의 토큰 동기화 등을 설정합니다. 배치 토큰 이름까지 동기화하는 옵션을 켜면 다음 액터 개명 시 개별 토큰의 별도 이름도 바뀔 수 있습니다.
- **스크린 패널:** 액터 디렉터리에서 새 액터의 유형을 **스크린 패널**로 만들고, 패널 시트에서 **면 추가**를 눌러 각 면의 이미지를 지정합니다. 시트의 **현재 씬에 올리기**, 액터 디렉터리 메뉴, 또는 캔버스로 드래그하여 배치합니다. 캔버스에서 우클릭하면 면 전환·표시/숨김·위치 고정 등을 조작할 수 있습니다. 시트에서 더블클릭 면 전환을 켰다면 더블클릭으로 다음 면을 보여 줍니다. 각 면에는 연결 액터의 값, 고정 텍스트, 값 바를 오버레이로 얹을 수 있습니다. GM은 우클릭 메뉴에서 플레이어에게 조작권을 줄 수 있습니다. **토큰화**를 켜면 타일 대신 토큰으로 배치되며, 이미 배치한 패널도 전환됩니다. 토큰화된 패널은 면마다 토큰 설정을 따로 지정할 수 있습니다.
- **씬 도구와 설정 창:** 인터페이스 탭에서 좌상단 레이어·도구 줄을 한 칸으로 접을 수 있습니다. 현재 선택된 칸을 클릭해 펼치거나 다시 접습니다. 씬 설정 창의 탭을 한 줄로 표시하는 옵션도 있습니다.
- **어트리뷰트 이름 도우미:** 인터페이스 탭에서 켜면 시트나 채팅의 값에 마우스를 올렸을 때 `system.attributes.hp.value` 같은 데이터 경로를 툴팁으로 확인할 수 있습니다. 값 자체는 표시하지 않습니다.
- **타일 애니메이션:** 토큰·패널 탭에서 타일에 쓰인 GIF·WebP·APNG의 프레임 재생을 켜거나 끌 수 있습니다.

### 전투와 시스템별 기능

- **컴뱃 트래커:** 전투가 시작되면 화면 상단에 전투원 포트레이트와 턴 조작 버튼이 나타납니다. 포트레이트를 클릭하면 토큰으로 이동·선택하고, 더블클릭하면 액터 시트를 엽니다. GM은 포트레이트를 우클릭해 숨김, 사망 표시, HP, 이니셔티브와 순서 등을 관리할 수 있습니다. **수치 숨기기/공개**는 액터의 스테이터스 UI와도 같은 상태를 사용합니다. 컴뱃 트래커 탭에서 포트레이트 크기·배치, HP 표시와 동적 포트레이트를 설정합니다.
- **턴 알림:** 컴뱃 트래커 탭의 별도 설정입니다. 턴이 넘어갈 때 현재 전투원 포트레이트를 큰 배너로 보여 주고, 다음 차례 표시 여부도 정할 수 있습니다.
- **DX3rd:** 액터 시트 머리말의 **스테이터스에 추가**나 토큰 메뉴의 스테이터스 버튼으로 액터를 고르면 HP·자원을 보여 주는 카드가 나타납니다. 인터페이스 탭에서 전체 표시를 켜거나 끌 수 있으며, 전투 중에는 설정에 따라 상단 컴뱃 트래커에 표시를 양보합니다.
- **D&D 5e:** 커스텀 상태·피해 유형, 아이템 시트 표시 옵션, 동봉된 **Tidy 5e Sheet-Classic** 시트가 제공됩니다. Classic 시트는 액터·아이템의 시트 설정에서 선택할 수 있습니다. 커스텀 상태와 피해 유형은 GM이 필요한 경우에만 활성화하세요. 이 항목을 바꾼 뒤에는 월드를 새로고침해야 합니다.
- **그 밖의 시스템:** 공통 채팅·폰트·레트로 테마 기능은 시스템을 가리지 않고 사용할 수 있습니다. Dungeon World와 LANCER 등에는 별도 외형 보정이 적용됩니다.

### 음악

GM이 음악 탭에서 기능을 켜고 월드를 다시 불러오면, **플레이리스트 사이드바 머리말의 음표 버튼**으로 **Emanim Music** 창을 엽니다. 파일을 선택하거나 창에 드롭하면 공용 플레이리스트에 트랙이 추가됩니다. 모든 플레이어가 재생·정지와 **이 곡만 재생**을 사용할 수 있으며, 트랙 삭제는 GM만 할 수 있습니다. 플레이리스트 사이드바의 트랙 슬라이더로 재생 위치를 이동하고, 볼륨은 별도 버튼에서 조절합니다. 직접 파일 업로드 권한이 없는 플레이어의 업로드에는 온라인 GM이 필요합니다. 파일당 업로드 한도와 저장 폴더는 GM이 음악 탭에서 정합니다.

### GM과 개인 설정

**GM 설정 전역 강제**가 켜져 있으면 채팅 외형, 무대, 이미지 호버, 컴뱃 트래커 등 대부분의 모듈 설정이 GM 값으로 통일됩니다. 폰트 사용 여부·사용자 로컬 폰트, 채팅 아카이브, 씬 툴바 접기는 개인 설정으로 남습니다. 이 강제를 끄면 플레이어의 이전 개인 설정이 복원됩니다. 별도 항목인 **일반 환경 설정 GM 강제**는 Foundry 자체의 클라이언트 설정에도 적용되므로, 언어·성능·접근성 설정까지 통일할지 확인하고 사용하세요.

**GM: PC 토큰 선택 시 본인 이름으로 채팅**을 켜면 GM이 플레이어 캐릭터 토큰을 선택한 채 일반 채팅을 보내도 캐릭터 대신 GM 이름으로 표시됩니다. 시스템에서 생성한 주사위 메시지는 해당 액터의 발화 정보를 유지합니다.

기능이 다른 모듈과 겹치면 **일반 → 충돌 모듈 가드**의 동작을 확인하세요. 중복 기능을 자동으로 이관하거나 경고하도록 설정할 수 있습니다.

GM에게는 새 모듈 버전이 나왔을 때 업데이트 알림이 표시됩니다. 실제 업데이트는 Foundry의 애드온 모듈 관리 화면에서 진행합니다.

## Font Licenses

This module bundles the following fonts. Full license texts are
consolidated in [`font/LICENSES.txt`](font/LICENSES.txt).

- **CookieRun** (© Devsisters Corp.) – used under the official CookieRun Font License.
- **학교안심 그림일기체** (© 서울특별시교육청) – free font, redistributed under its free-use terms.
- **Neo둥근모** / **Neo둥근모 Pro** (© Eunbin Jeong / Dalgona.) – SIL Open Font License 1.1.

## Licenses

The bundled Tidy 5e Sheet-Classic layout is maintained by **EnYuri** as part of female_edition. It is a fork of the MIT-licensed Tidy 5e Sheets v12.5.5, originally created by **kgar**. The upstream source is available at [kgar/foundry-vtt-tidy-5e-sheets](https://github.com/kgar/foundry-vtt-tidy-5e-sheets). Report issues with this fork at [female_edition/issues](https://github.com/EnYuri/female_edition/issues).

## 日本語 — 使用ガイド

### インストールと初期設定

Female-cupwhiはFoundry Virtual Tabletop v13・v14向けのモジュールです。チャット、画面表示、戦闘、画像、音楽の機能を一つの設定画面から調整できます。複数のゲームシステムに対応していますが、D&D 5eやDX3rd専用の機能は対象システムでのみ動作します。

1. Foundryのアドオンモジュールのインストール画面で、[最新リリースのマニフェストURL](https://github.com/EnYuri/female_edition/releases/latest/download/module.json)を指定してインストールします。手動の場合は、このリポジトリを`Data/modules/`に配置します。
2. ワールドのモジュール管理で**Female-cupwhi**を有効にして、ワールドに接続します。
3. **ゲーム設定 → モジュール設定 → Female-cupwhiの統合設定パネル**を開き、設定を変更して保存します。一般、チャット機能・外観・結合、ポートレート、アーカイブ、インターフェース、画像、音楽、コンバットトラッカー、ステージチャット、トークン・パネルのタブがあります。

一部の設定は保存後に再読み込みが必要です。インストールや更新の直後は、ワールドを一度終了して再度開き、新しいマニフェストとスクリプトを読み込んでください。

### フォントと画面テーマ

**一般 → フォント**でカスタムフォントを有効にすると、同梱フォントを選択できます。PCにインストールされたフォントやモジュールの`font/`フォルダに追加したフォントを使う場合は、ユーザー（ローカル）フォントを有効にして、一覧から選ぶかフォント名を入力します。システムフォントの読み込み時には、ブラウザがローカルフォントへのアクセス許可を求める場合があります。トークン名、カーソル、描画、マップノートへのフォント適用も個別に設定できます。

**一般 → レトロテーマ**はウィンドウとUIを角張ったピクセル風の外観に変更します。フォントとテーマはそれぞれ独立して切り替えられます。

### チャット

- **Markdownと編集:** チャット機能タブで有効にします。`**太字**`などの書式を使用できます。編集権限のあるメッセージの鉛筆アイコンやメニューから編集画面を開きます。Markdown原文とHTML原文を切り替えられ、`Enter`で保存、`Shift+Enter`で改行、`Esc`でキャンセルします。
- **連続メッセージの結合:** 同じ話者の連続メッセージをまとめて表示します。トークン・アクター・プレイヤーのどれを基準にするか、ダイスやチャットカードを含めるか、名前とポートレートをどう表示するかを設定できます。
- **ポートレートと外観:** ポートレートタブでサイズ・形状・表示対象を、チャット外観タブで背景テクスチャ、ユーザーカラー、文字サイズ、間隔などを調整します。
- **画像の送信:** チャット入力欄の画像アップロードボタンを使うか、画像を入力欄に貼り付け・ドロップします。ボタンが見えない場合はチャットコントロールのメニューを確認してください。サーバー上の画像は`!ci|画像/パス.webp!`の形式でも挿入できます。チャット内の画像をクリックすると拡大表示します。直接アップロードする権限がないプレイヤーはオンラインGM経由でアップロードし、失敗時には画像をメッセージに直接埋め込む方式が使われる場合があります。
- **入力中表示とチャット整理:** チャット機能タブで設定します。DOM整理は画面上に保持するメッセージ数を制限する機能で、ワールドに保存された古いメッセージを削除するものではありません。

### チャットアーカイブ

1. チャットコントロールのメニューからチャットログのPDF/HTMLエクスポートを選びます。
2. 全ログまたはメッセージ範囲を指定します。最も古いメッセージが1番です。
3. ブラウザでは開いたアーカイブからHTML保存または印刷/PDFを選びます。FoundryデスクトップアプリではHTMLを保存し、ChromeまたはEdgeで開いてPDFに印刷してください。

アーカイブタブでは画像・フォントの埋め込み、PDF用の画像品質、ささやきの除外などを設定できます。GMがささやきの除外を無効にすると、GMに見える非公開会話も保存される場合があるため、出力前に確認してください。

### ステージチャットとナレーター

**ステージチャット:** アクターシートのヘッダーやアクターディレクトリのメニューからキャラクターをステージに追加します。チャットのステージ選択メニューで話者を選び、通常どおり送信するとポートレートと台詞ウィンドウに表示されます。表情の選択、過去の台詞の呼び出し、台詞ウィンドウの閉じるボタンを利用できます。アクターのステージ設定で表示名、基本ポートレート、表情ごとの画像を指定します。

**ナレーター:** `/narrate 本文`はシネマティックなナレーションとチャットメッセージを表示し、設定変更権限が必要です。`/describe 本文`は描写、`/note 本文`はGMへの通知を送ります。`/as 名前`は以後の通常チャットの別名を指定し、`/as`だけで解除します。コマンド名は英語のままで、各コマンドの最低ユーザーロールはGMがステージチャットタブで設定します。ステージ話者を選択している間は、通常の別名よりステージ話者が優先されます。

### 画像、トークン、スクリーンパネル

- **画像ホバー:** 画像タブで有効にすると、`X`キーを押しながらトークンにマウスを重ねたときにキャラクター画像を拡大表示します。位置、サイズ、遅延、使用画像、最低権限を設定できます。
- **ファイルピッカー:** インターフェースタブの拡張を有効にすると、プレビューと名前・日付・サイズの並べ替えが使えます。**現在のフォルダに画像をアップロード**は既定で**ON**です。アップロード権限のあるユーザーが画像を貼り付け・ドロップすると、現在開いているフォルダに保存して画像を選択します。アップロードできないフォルダではエラーを表示します。GMがこの設定を**OFF**にすると、指定の外部画像アップロード先（既定`uploaded-filepicker-images`）にまとめて保存します。チャット画像の保存先とは別です。
- **トークン設定プレビュー:** インターフェースタブで有効にすると、プロトタイプトークン設定で画像・サイズ・アンカーをグリッド上にプレビューできます。ほかのトークン設定タブを2列にするオプションもあります。
- **トークン表示:** トークン・パネルタブで選択・ホバー・ターゲットのグロー、照準線、アクター名との同期を設定します。配置済みトークン名の同期も有効にすると、次回のアクター名変更時に個別のトークン名も変更される場合があります。
- **スクリーンパネル:** アクターディレクトリでスクリーンパネル型のアクターを作成し、シートに面を追加して画像を指定します。シート、ディレクトリのメニュー、またはキャンバスへのドラッグで配置できます。右クリックで面の切り替え、表示・非表示、位置固定などを操作します。シートで有効にすればダブルクリックでも次の面に切り替わります。各面にはリンクしたアクターの値、固定テキスト、値バーを重ねられます。GMは右クリックメニューからプレイヤーに操作権限を渡せます。トークン化を有効にするとタイルではなくトークンとして配置され、配置済みパネルも変換されます。トークン化したパネルでは面ごとにトークン設定を指定できます。
- **シーンツールと設定:** インターフェースタブで左上のレイヤー・ツールバーを折りたためます。選択中のボタンをクリックして展開・折りたたみを切り替えます。シーン設定のタブを1行に表示するオプションもあります。
- **属性パスのヘルパー:** シートやチャットの値にマウスを重ねると、`system.attributes.hp.value`などのデータパスを表示します。値そのものは表示しません。
- **タイルアニメーション:** トークン・パネルタブで、タイルに使うGIF・WebP・APNGのフレーム再生を切り替えられます。

### 戦闘とシステム固有の機能

- **コンバットトラッカー:** 戦闘中は画面上部に戦闘参加者のポートレートとターン操作を表示します。クリックでトークンへ移動・選択し、ダブルクリックでアクターシートを開きます。GMは右クリックから非表示、死亡状態、HP、イニシアチブ、順番などを管理できます。数値の非公開・公開はアクターのステータスUIと共通です。専用タブでサイズ、配置、HP表示、動的ポートレートを設定します。
- **ターン通知:** コンバットトラッカーとは別の設定で、ターン変更時に現在の参加者のポートレートを大きなバナーで表示します。次の参加者を表示するかも指定できます。
- **DX3rd:** アクターシートのヘッダーやトークンメニューからステータスに追加すると、HP・リソースのカードを表示します。インターフェースタブで表示を切り替えられ、戦闘中は設定に応じて上部トラッカーに表示を譲ります。
- **D&D 5e:** カスタム状態・ダメージタイプ、アイテムシートの表示オプション、同梱の**Tidy 5e Sheet-Classic**を利用できます。Classicはアクター・アイテムのシート設定で選択します。カスタム状態・ダメージタイプはGMが必要なものだけ有効にし、変更後にワールドを再読み込みしてください。
- **その他のシステム:** 共通のチャット、フォント、レトロテーマはシステムを問わず利用できます。Dungeon WorldやLANCERなどには専用の外観調整があります。

### 音楽

GMが音楽タブで機能を有効にしてワールドを再読み込みすると、プレイリストサイドバーのヘッダーにある音符ボタンから**Emanim Music**を開けます。ファイルを選択またはドロップすると共有プレイリストに追加されます。全プレイヤーが再生・停止と選択曲のみの再生を利用でき、削除はGMのみ可能です。サイドバーのトラックスライダーで再生位置を変更し、音量は別のボタンで調整します。直接アップロード権限のないプレイヤーにはオンラインGMが必要です。ファイルごとの上限と保存先はGMが音楽タブで設定します。

### GM設定と個人設定

**GM設定の強制**が有効な間は、チャット外観、ステージ、画像ホバー、コンバットトラッカーなど、ほとんどのモジュール設定がGMの値に統一されます。フォントの使用・ローカルフォント、チャットアーカイブ、シーンツールバーの折りたたみは個人設定のままです。強制を解除すると以前の個人設定が復元されます。別項目のFoundry本体のクライアント設定の強制は、言語・性能・アクセシビリティにも影響するため、適用範囲を確認してください。

GMがPCトークンを選択しても自分の名前で発言する設定を有効にすると、通常チャットはキャラクター名ではなくGM名で表示されます。システムが生成するダイスメッセージはアクターの話者情報を維持します。

他のモジュールと機能が重複する場合は、**一般 → 競合モジュールガード**を確認してください。重複機能の自動引き継ぎや警告を設定できます。新バージョンの通知はGMに表示されますが、更新操作はFoundryのアドオンモジュール管理画面で行います。

## English — User Guide

### Installation and First Setup

Female-cupwhi is a module for Foundry Virtual Tabletop v13 and v14. It brings chat, display, combat, image, and music options into one settings panel. It supports multiple game systems; system-specific features for D&D 5e, DX3rd, and others only operate in their respective systems.

1. Install it through Foundry's **Install Module** dialog using the [latest release manifest URL](https://github.com/EnYuri/female_edition/releases/latest/download/module.json). For manual installation, place this repository under `Data/modules/`.
2. Enable **Female-cupwhi** in your world's **Manage Modules** dialog and enter the world.
3. Open **Game Settings → Module Settings → Female-cupwhi's unified settings panel**, adjust the options, and save. Tabs cover general settings, chat features/appearance/merging, portraits, archives, interface, images, music, combat tracker, stage chat, and tokens/panels.

Some settings require a refresh or reconnect after saving. After installing or updating the module, close and reopen the world to load the new manifest and scripts.

### Fonts and Display Theme

Enable custom fonts under **General → Fonts** to choose a bundled font. To use a font installed on your computer or added to the module's `font/` directory, enable user/local fonts and select a font or enter its family name. Loading system fonts may request browser permission to access local fonts. Font application to token names, cursors, drawings, and map notes can also be configured separately.

**General → Retro Theme** gives windows and UI a square, pixel-style appearance. Fonts and the theme can be enabled independently.

### Chat

- **Markdown and editing:** Enable these in the chat features tab. Use syntax such as `**bold**` for formatting. Open the editor through the pencil icon or menu on a message you can edit. Switch between Markdown and HTML source; `Enter` saves, `Shift+Enter` inserts a line break, and `Esc` cancels.
- **Consecutive message merging:** Group consecutive messages from the same speaker. Choose token, actor, or player as the grouping basis, whether to include rolls and chat cards, and how names and portraits appear.
- **Portraits and appearance:** Configure portrait size, shape, and eligible messages in the portraits tab. Adjust background textures, user colors, text size, spacing, and more in the chat appearance tab.
- **Sending images:** Use the chat input's upload button or paste/drop an image into the input. If the button is not visible, check the chat controls menu. Images already on the server can also be inserted with `!ci|image/path.webp!`. Click a chat image to enlarge it. Players without direct upload permission upload through an online GM; if that fails, an image may instead be embedded directly in the message.
- **Typing notifications and chat cleanup:** Configure these in the chat features tab. DOM cleanup limits how many messages remain rendered to reduce the cost of long histories; it does not delete older messages from world data.

### Saving Chat Archives

1. Choose the PDF/HTML chat export action from the chat controls menu.
2. Select the entire log or a message range. Message 1 is the oldest message.
3. In a web browser, choose HTML save or Print/PDF in the archive window. In the Foundry desktop app, save the HTML archive, open it in Chrome or Edge, and print it to PDF.

The archive tab controls embedded images/fonts, PDF image quality, whisper exclusion, and other options. If a GM disables whisper exclusion, private conversations visible to that GM may be included. Check this before saving or sharing an archive.

### Stage Chat and Narrator

**Stage chat:** Add a character through the actor sheet header or actor directory menu. Select a speaker from the chat's stage menu and send a message normally to display it with a portrait and dialogue box. Controls let you choose expressions, recall earlier dialogue, and close the dialogue box. Configure display names, default portraits, and expression images in the actor's stage settings.

**Narrator:** `/narrate text` displays cinematic narration and a chat message; it requires permission to modify settings. `/describe text` sends a descriptive message, and `/note text` sends a notification to the GM. `/as name` sets an alias for subsequent ordinary chat; `/as` alone clears it. Command names remain English, and the GM configures their minimum user roles in the stage chat tab. A selected stage speaker takes precedence over an ordinary chat alias.

### Images, Tokens, and Screen Panels

- **Image hover:** Enable this in the images tab to enlarge character art while hovering over a token and holding `X`. Configure position, size, delay, image source, and minimum permission.
- **File picker:** Enable the interface enhancement for previews and sorting by name, date, or size. **Upload images to current folder** is **ON by default**: users with upload permission can paste/drop images into the picker to save them in the currently browsed folder and select the uploaded image. Folders that do not allow uploads report an error. If the GM switches this setting **OFF**, images are collected in the configured external-image upload directory, defaulting to `uploaded-filepicker-images`. This directory is separate from chat image uploads.
- **Token configuration preview:** Enable this in the interface tab to preview the prototype token's image, size, and anchor on a grid. A two-column layout for other token configuration tabs is also available.
- **Token display:** Configure selection/hover/target glow, targeting lines, and actor-name synchronization in the tokens/panels tab. Enabling synchronization for placed token names may replace individual token names when the actor is next renamed.
- **Screen panels:** Create an actor of the screen panel type, add faces in its sheet, and assign their images. Place it through the sheet, the actor directory menu, or by dragging it onto the canvas. Right-click to change faces, show/hide the panel, or lock its position. Enable double-click face switching in the sheet if desired. Each face can display linked actor values, fixed text, and value bars as overlays. The GM can grant players control through the context menu. Tokenization places the panel as a token instead of a tile and also converts existing placements. Tokenized panels support separate token settings for each face.
- **Scene tools and configuration:** Collapse the upper-left layer/tool controls from the interface tab, then click the selected control to expand or collapse them. An option also keeps scene configuration tabs on one line.
- **Attribute path helper:** Hover over values in sheets or chat to see data paths such as `system.attributes.hp.value`. The tooltip shows the path, not the value itself.
- **Animated tiles:** Toggle frame playback for GIF, WebP, and APNG tiles in the tokens/panels tab.

### Combat and System-Specific Features

- **Combat tracker:** During combat, a strip at the top of the screen shows combatant portraits and turn controls. Click a portrait to navigate to/select its token; double-click to open its actor sheet. GMs can right-click to manage visibility, defeated status, HP, initiative, and order. Hiding/revealing resource numbers shares state with the actor's status UI. Configure portrait size, layout, HP display, and dynamic portraits in the combat tracker tab.
- **Turn notice:** A separate combat tracker setting displays the current combatant's portrait in a large banner when the turn changes. You can also choose whether to show the next combatant.
- **DX3rd:** Add an actor to the status display through its sheet header or token menu to show an HP/resource card. Toggle the display in the interface tab; during combat it can yield to the top tracker according to your settings.
- **D&D 5e:** Includes custom conditions/damage types, item sheet display options, and the bundled **Tidy 5e Sheet-Classic** layout. Select Classic in the actor/item sheet configuration. GMs should only enable custom conditions and damage types they need, then reload the world after changing them.
- **Other systems:** Shared chat, font, and retro theme features work across systems. Dungeon World, LANCER, and others also receive system-specific appearance adjustments.

### Music

After the GM enables music and reloads the world, open **Emanim Music** through the musical-note button in the playlist sidebar header. Selecting or dropping files adds tracks to a shared playlist. All players can play, stop, or play only the selected track; only GMs can delete tracks. Use the sidebar's track slider to seek and the separate volume control to adjust volume. Players without direct upload permission need an online GM. The GM sets the per-file upload limit and destination directory in the music tab.

### GM and Personal Settings

When **GM setting enforcement** is enabled, most module settings—including chat appearance, stage chat, image hover, and combat tracker—follow the GM's values. Font enablement/local fonts, chat archive preferences, and scene toolbar collapsing remain personal. Disabling enforcement restores players' previous preferences. The separate option for enforcing Foundry's own client settings also affects language, performance, and accessibility; review its scope before enabling it.

Enable the GM speak-as-self option to keep ordinary chat under the GM's name even while a player character's token is selected. System-generated roll messages retain their actor speaker information.

If features overlap with another module, check **General → Conflict Module Guard**. It can automatically hand off overlapping features or warn about them. GMs receive notifications of new module versions; perform the actual update through Foundry's add-on module management screen.
