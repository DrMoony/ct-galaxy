# 배포 가이드 (GitHub Pages)

## 1단계: GitHub에 repository 만들기

1. https://github.com/new 접속
2. Repository name: `ct-galaxy`
3. Public 선택
4. "Add a README file" 체크 해제 (이미 있음)
5. Create repository 클릭

## 2단계: 이 폴더를 push

터미널(PowerShell/CMD)에서:

```bash
cd "이 ct-galaxy 폴더 경로"
git init
git add .
git commit -m "Initial release: CT-Galaxy v1.0"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ct-galaxy.git
git push -u origin main
```

> YOUR_USERNAME을 본인 GitHub 아이디로 교체

## 3단계: GitHub Pages 활성화

1. GitHub repo 페이지 → Settings 탭
2. 왼쪽 메뉴 "Pages" 클릭
3. Source: "Deploy from a branch"
4. Branch: `main` / `/ (root)` 선택
5. Save 클릭

## 4단계: 접속 확인

1~2분 후 접속 가능:
```
https://YOUR_USERNAME.github.io/ct-galaxy/
```

## 업데이트 방법

파일 수정 후:
```bash
git add .
git commit -m "Update description"
git push
```

GitHub Pages가 자동으로 반영됩니다 (1~2분 소요).
