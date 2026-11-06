import { RuledSection } from "./ui";
import s from "./screens.module.css";

const MIT_TEXT = `MIT License

Copyright (c) 2026 CryptoZephyr

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

export function LicensePage() {
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Legal</p>
        <h1>License</h1>
        <p className={s.lede}>Seats is released under the MIT License. You can use, copy, change, and share it, including commercially, as long as the notice stays with it.</p>
      </header>
      <RuledSection title="MIT License">
        <pre className={s.licenseText}>{MIT_TEXT}</pre>
      </RuledSection>
      <RuledSection title="Third-party material">
        <p className={s.muted}>
          The typefaces Besley and Atkinson Hyperlegible are under the SIL Open Font License. The Atlas Icons
          used in the interface are under the MIT License, and their notice ships with the site.
        </p>
      </RuledSection>
    </main>
  );
}

export function PolicyPage() {
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Legal</p>
        <h1>Policy</h1>
        <p className={s.lede}>What Seats does with your data. Last updated 6 Nov 2026.</p>
      </header>
      <RuledSection title="Testnet only">
        <p>
          Seats runs on NEAR testnet. Testnet tokens have no monetary value. Don't send mainnet funds to any
          Seats account.
        </p>
      </RuledSection>
      <RuledSection title="What the site collects">
        <p>
          The site doesn't use analytics, cookies, or trackers. It makes read-only requests to the FastNear
          testnet RPC to show public contract data. Wallet connections use the wallet you choose. Fonts are
          bundled with the site.
        </p>
      </RuledSection>
      <RuledSection title="What is public on-chain">
        <p>
          Seat ownership, votes, sale transactions, payouts, each brief's hash, and receipt hashes are recorded
          on NEAR testnet. Anyone can read them.
        </p>
      </RuledSection>
      <RuledSection title="What stays off-chain">
        <p>
          In the testnet build, the brief text is held as an OutLayer secret and isn't published. Vault content
          comes back encrypted to the holder's own key.
        </p>
      </RuledSection>
      <RuledSection title="Reporting a security issue">
        <p>
          Report vulnerabilities through a private security advisory on the GitHub repository, not a public
          issue. See SECURITY.md in the repository.
        </p>
      </RuledSection>
    </main>
  );
}
