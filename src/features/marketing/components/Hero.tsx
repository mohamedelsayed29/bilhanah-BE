import { useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, PlayIcon, QrCodeIcon } from '@phosphor-icons/react';
import { useLanguage } from '../../../lib/language';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { chapterAtTime, heroStory } from '../data/hero-story';

export function Hero({ onStart, onDemo }: { onStart: () => void; onDemo: () => void }) {
  const { language, text } = useLanguage();
  const reduced = useReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [chapter, setChapter] = useState<number>(heroStory.initialChapter);
  const [videoFailed, setVideoFailed] = useState(false);
  const chapters = [
    { title: text('سكان للـQR', 'Scan the QR'), description: text('أول خطوة لتجربة ألذ', 'A better experience starts here'), ...heroStory.chapters[0] },
    { title: text('اكتشف المنيو', 'Explore the menu'), description: text('صور تفتح النفس', 'Find your next favorite'), ...heroStory.chapters[1] },
    { title: text('جاهز تطلب؟', 'Ready to order'), description: text('اختيار أسهل، وقت أحلى', 'Less waiting, more enjoying'), ...heroStory.chapters[2] },
  ];
  useEffect(() => {
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage) return;
    let inView = true;
    // The film plays continuously; it only rests off-screen, in a background tab, or when the visitor prefers reduced motion.
    const sync = () => { if (reduced || !inView || document.hidden) video.pause(); else void video.play().catch(() => undefined); };
    const observer = new IntersectionObserver(entries => { inView = entries[0].isIntersecting; sync(); });
    observer.observe(stage);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', sync); video.pause(); };
  }, [reduced]);
  const goToChapter = (index: number) => {
    setChapter(index);
    if (videoRef.current && Number.isFinite(videoRef.current.duration)) videoRef.current.currentTime = chapters[index].at + 0.65;
  };
  return <section className="hero" ref={stageRef} aria-labelledby="hero-title">
    <img className="hero-poster" src={chapters[videoFailed ? chapter : heroStory.initialChapter].poster} style={{ objectPosition: chapters[videoFailed ? chapter : heroStory.initialChapter].position }} alt="" fetchPriority="high" width="1280" height="720" />
    {!videoFailed && <video ref={videoRef} className="hero-video" style={{ objectPosition: chapters[chapter].position }} muted loop playsInline preload="metadata" poster={heroStory.chapters[heroStory.initialChapter].poster} aria-hidden="true"
      onLoadedMetadata={event => { event.currentTarget.currentTime = heroStory.startAt; }}
      onError={() => setVideoFailed(true)} onTimeUpdate={event => {
        const time = event.currentTarget.currentTime;
        const next = chapterAtTime(time);
        setChapter(current => current === next ? current : next);
      }}><source src={heroStory.src} type="video/mp4" /></video>}
    <div className="hero-shade" />
    <div className="hero-inner">
      <div className="hero-content" dir={language === 'ar' ? 'rtl' : 'ltr'}>
        <h1 id="hero-title">{text('منيو يفتح النفس.', 'A menu worth opening.')}<span>{text('وضيافة تليق بيك.', 'Hospitality, your way.')}</span></h1>
        <p>{text('من أول سكان لحد آخر لقمة. منيو ديجيتال وطلبات أسهل، باسم مطعمك وبطريقتك.', 'From the first scan to the last bite. Your digital menu and easier ordering, made your way.')}</p>
        <div className="hero-actions">
          <button className="button button-ivory" onClick={onStart}>{text('جرّب ٣٠ يوم مجانًا', 'Try 30 days free')}<ArrowLeftIcon className="directional-arrow" size={20} /></button>
          <button className="button button-video" onClick={onDemo}><span className="play-circle"><PlayIcon weight="fill" size={13} /></span>{text('شوف منيو حقيقي', 'Explore a sample menu')}</button>
        </div>
      </div>
      <div className="hero-bottom" dir={language === 'ar' ? 'rtl' : 'ltr'}>
        <div className="hero-chapters" aria-label={text('مشاهد تجربة المنيو', 'Menu experience chapters')}>
          {chapters.map((item, index) => <button key={item.at} onClick={() => goToChapter(index)} className={`chapter ${chapter === index ? 'is-active' : ''}`} aria-pressed={chapter === index}>
            <span className="chapter-number" dir="ltr">0{index + 1}</span><span><strong>{item.title}</strong><small>{item.description}</small></span>
          </button>)}
        </div>
        <div className="hero-caption"><QrCodeIcon size={18} /><span>{text('ضيافة تبدأ بسكان.', 'Good hospitality starts with a scan.')}</span></div>
      </div>
    </div>
  </section>;
}
