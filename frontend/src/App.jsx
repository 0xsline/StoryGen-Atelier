import React, { useEffect, useState, useRef } from 'react';
import { generateStoryboardApi, generateVideoApi, listGalleryApi, saveGalleryApi, deleteGalleryApi, regenerateShotImageApi } from './api';
import VideoLogs from './VideoLogs';
import {
  Container,
  Title,
  Text,
  Textarea,
  Button,
  Group,
  Stack,
  SimpleGrid,
  Card,
  Image,
  Badge,
  NumberInput,
  Slider,
  Alert,
  Skeleton,
  Modal,
  ScrollArea,
  Select,
  TextInput,
  ActionIcon,
} from '@mantine/core';
import './App.css';

function App() {
  const [sentence, setSentence] = useState('');
  const [shotCount, setShotCount] = useState(6);
  const [styleOption, setStyleOption] = useState('cyberpunk');
  const [customStyle, setCustomStyle] = useState('');
  const [storyboard, setStoryboard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videos, setVideos] = useState([]);
  const [fullscreenVideo, setFullscreenVideo] = useState(null);
  const [currentStoryId, setCurrentStoryId] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [error, setError] = useState(null);
  const [savedStories, setSavedStories] = useState([]);
  const [viewStory, setViewStory] = useState(null);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [regeneratingIndex, setRegeneratingIndex] = useState(null);

  const resetHome = () => {
    setSentence('');
    setShotCount(6);
    setStyleOption('cyberpunk');
    setCustomStyle('');
    setStoryboard(null);
    setVideos([]);
    setFullscreenVideo(null);
    setError(null);
    setViewStory(null);
    setCurrentStoryId(null);
    setPreviewImage(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDownloadImage = (imageUrl, filename) => {
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = filename || 'shot.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const stylePresets = [
    { value: 'cyberpunk', label: '赛博朋克/霓虹', text: 'Cinematic neon-noir, teal-magenta palette, volumetric rain and fog, soft bloom, anamorphic lens, shallow depth of field, film grain' },
    { value: 'filmic', label: '电影写实', text: 'Filmic realism, natural lighting, soft bokeh, 35mm lens, muted colors, subtle grain' },
    { value: 'watercolor', label: '水彩画', text: 'Watercolor illustration, soft edges, pastel palette, paper texture, gentle gradients' },
    { value: 'anime', label: '动漫风', text: 'Anime cinematic style, vibrant colors, clean lines, dramatic lighting, expressive characters' },
    { value: 'noir', label: '黑白胶片', text: 'Black and white film noir, high contrast, strong shadows, rim lighting, grainy texture' },
    { value: 'ghibli', label: '吉卜力风', text: 'Studio Ghibli style, hand-painted backgrounds, soft lighting, whimsical atmosphere, lush nature, dreamy clouds' },
    { value: 'oilpainting', label: '油画风', text: 'Classical oil painting style, rich textures, dramatic chiaroscuro lighting, Renaissance composition, visible brushstrokes' },
    { value: 'pixar', label: '皮克斯3D', text: 'Pixar 3D animation style, vibrant saturated colors, soft global illumination, expressive characters, detailed textures' },
    { value: 'inkwash', label: '水墨国风', text: 'Chinese ink wash painting, minimalist composition, flowing brushstrokes, misty mountains, traditional aesthetics, monochrome with subtle color accents' },
    { value: 'scifi', label: '科幻未来', text: 'Futuristic sci-fi, sleek metallic surfaces, holographic displays, blue and orange color scheme, epic scale, lens flares' },
    { value: 'fantasy', label: '奇幻魔法', text: 'Epic fantasy style, magical glowing elements, dramatic lighting, mythical creatures, rich jewel tones, cinematic composition' },
    { value: 'retro', label: '复古怀旧', text: 'Vintage retro aesthetic, warm sepia tones, film grain, light leaks, 1970s color palette, nostalgic mood' },
    { value: 'comic', label: '美漫风', text: 'American comic book style, bold outlines, halftone dots, dynamic action poses, vibrant primary colors, dramatic shadows' },
    { value: 'minimalist', label: '极简主义', text: 'Minimalist design, clean geometric shapes, limited color palette, negative space, modern aesthetics, subtle gradients' },
    { value: 'steampunk', label: '蒸汽朋克', text: 'Steampunk aesthetic, brass and copper machinery, Victorian architecture, gears and clockwork, warm amber lighting, industrial fog' },
    { value: 'custom', label: '自定义', text: '' },
  ];

  const resolveStyleText = () => {
    if (styleOption === 'custom') return customStyle;
    const found = stylePresets.find((s) => s.value === styleOption);
    return found?.text || '';
  };

  useEffect(() => {
    const fetchGallery = async () => {
      setGalleryLoading(true);
      try {
        const stories = await listGalleryApi();
        setSavedStories(stories);
      } catch (err) {
        console.error('Load gallery failed', err);
      } finally {
        setGalleryLoading(false);
      }
    };
    fetchGallery();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setStoryboard(null);
    setVideos([]);
    setCurrentStoryId(null);

    try {
      const styleText = resolveStyleText();
      const generatedStoryboard = await generateStoryboardApi(sentence, shotCount, styleText);
      setStoryboard(generatedStoryboard);
    } catch (err) {
      setError(err.message);
      console.error('Error in App.jsx:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateVideo = async () => {
    if (!storyboard) return;

    setVideoLoading(true);
    setError(null);
    try {
      const url = await generateVideoApi(storyboard);
      const newVideo = { url, createdAt: new Date().toISOString() };
      const updatedVideos = [...videos, newVideo];
      setVideos(updatedVideos);

      if (currentStoryId) {
        const existingStory = savedStories.find((s) => s.id === currentStoryId);
        if (existingStory) {
          const updatedStory = {
            ...existingStory,
            storyboard,
            videos: updatedVideos,
          };
          saveGalleryApi(updatedStory)
            .then((saved) => {
              setSavedStories((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
            })
            .catch((err) => console.error('Auto-save video failed:', err));
        }
      } else {
        const newStory = {
          title: sentence,
          createdAt: new Date().toISOString(),
          shotCount: storyboard.length,
          storyboard,
          style: resolveStyleText(),
          videos: updatedVideos,
        };
        saveGalleryApi(newStory)
          .then((saved) => {
            setSavedStories((prev) => [...prev, saved]);
            setCurrentStoryId(saved.id);
          })
          .catch((err) => console.error('Auto-save story with video failed:', err));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setVideoLoading(false);
    }
  };

  const isPlaceholderImage = (url) => {
    if (!url) return true;
    return url.includes('placehold.co');
  };

  const handleRegenerateShotImage = async (index) => {
    if (!storyboard || index < 0 || index >= storyboard.length) return;

    setRegeneratingIndex(index);
    setError(null);

    try {
      const shot = storyboard[index];
      const styleText = resolveStyleText();
      
      let referenceImageBase64 = null;
      if (index > 0 && storyboard[0]?.imageUrl?.startsWith('data:')) {
        referenceImageBase64 = storyboard[0].imageUrl.split(',')[1];
      }
      
      const heroSubject = storyboard[0]?.heroSubject || '';
      const previousStyleHint = index > 0 ? storyboard[index - 1]?.prompt || '' : '';

      const newImageUrl = await regenerateShotImageApi(
        shot,
        styleText,
        referenceImageBase64,
        heroSubject,
        previousStyleHint
      );

      const updatedStoryboard = [...storyboard];
      updatedStoryboard[index] = { ...updatedStoryboard[index], imageUrl: newImageUrl };
      setStoryboard(updatedStoryboard);

      const existingStory = savedStories.find((s) => s.title === sentence);
      if (existingStory) {
        const updatedStory = {
          ...existingStory,
          storyboard: updatedStoryboard,
        };
        saveGalleryApi(updatedStory)
          .then((saved) => {
            setSavedStories((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
          })
          .catch((err) => console.error('Auto-save failed:', err));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setRegeneratingIndex(null);
    }
  };

  const handleSaveStory = () => {
    if (!storyboard || !sentence) return;
    const story = {
      id: currentStoryId || undefined,
      title: sentence,
      createdAt: new Date().toISOString(),
      shotCount: storyboard.length,
      storyboard,
      style: resolveStyleText(),
      videos,
    };
    saveGalleryApi(story)
      .then((saved) => {
        setSavedStories((prev) => [...prev.filter((s) => s.id !== saved.id), saved]);
        setCurrentStoryId(saved.id);
      })
      .catch((err) => setError(err.message));
  };

  const handleLoadStory = (id) => {
    const story = savedStories.find((s) => s.id === id);
    if (!story) return;
    setSentence(story.title);
    setStoryboard(story.storyboard);
    setShotCount(story.shotCount || story.storyboard.length || 6);
    if (story.style) {
      setStyleOption('custom');
      setCustomStyle(story.style);
    }
    setVideos(story.videos || []);
    setCurrentStoryId(story.id);
    setViewStory(null);
  };

  const handleDeleteStory = (id) => {
    deleteGalleryApi(id)
      .then((stories) => setSavedStories(stories))
      .catch((err) => setError(err.message));
  };

  const handleViewStory = (story) => {
    setViewStory(story);
  };

  const renderShots = () => {
    if (loading) {
      return (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
          {Array.from({ length: shotCount || 6 }).map((_, idx) => (
            <Card key={idx} className="shot-card" padding="lg" radius="lg" shadow="lg" withBorder>
              <Skeleton height={18} width="60%" radius="sm" mb="sm" />
              <Skeleton height={16} width="30%" radius="sm" mb="md" />
              <Skeleton height={220} radius="md" mb="md" />
              <Skeleton height={14} radius="sm" mb={8} />
              <Skeleton height={14} radius="sm" width="80%" />
            </Card>
          ))}
        </SimpleGrid>
      );
    }

    if (!storyboard) return null;

    return (
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
        {storyboard.map((shot, index) => {
          const isFailed = isPlaceholderImage(shot.imageUrl);
          const isRegenerating = regeneratingIndex === index;
          return (
            <Card key={`shot-${index}`} className="shot-card" padding="lg" radius="lg" shadow="xl" withBorder>
              <div
                className={`shot-image-wrapper ${isFailed ? 'shot-image-failed' : ''}`}
                onClick={isFailed && !isRegenerating ? () => handleRegenerateShotImage(index) : (!isFailed && !isRegenerating ? () => setPreviewImage({ url: shot.imageUrl, name: `shot_${index + 1}.png` }) : undefined)}
                style={{ cursor: isFailed || !isRegenerating ? 'pointer' : undefined }}
                title={isFailed ? '点击重新生成' : '点击放大'}
              >
                {isRegenerating ? (
                  <Skeleton height={220} radius="md" />
                ) : (
                  <Image
                    src={shot.imageUrl}
                    alt={`Shot ${shot.shot}`}
                    height={220}
                    radius="md"
                    withPlaceholder
                    className="shot-image"
                  />
                )}
                {isFailed && !isRegenerating && (
                  <div className="shot-retry-overlay">
                    <Text size="sm" c="white">点击重新生成</Text>
                  </div>
                )}
              </div>
              <Title order={4} className="shot-title" mb="sm">
                {shot.description}
              </Title>
              <Text size="md" className="shot-prompt">
                {shot.shotStory || shot.prompt}
              </Text>
            </Card>
          );
        })}
        {videos.map((video, idx) => (
          <Card key={`video-${idx}`} className="shot-card video-shot-card" padding="lg" radius="lg" shadow="xl" withBorder>
            <div className="shot-image-wrapper video-wrapper">
              <video
                src={video.url}
                className="video-thumbnail"
                muted
                loop
                playsInline
                onMouseEnter={(e) => e.target.play()}
                onMouseLeave={(e) => { e.target.pause(); e.target.currentTime = 0; }}
              />
              <div className="video-overlay">
                <ActionIcon
                  variant="filled"
                  color="cyan"
                  size="xl"
                  radius="xl"
                  onClick={() => setFullscreenVideo(video.url)}
                >
                  <span style={{ fontSize: 20 }}>▶</span>
                </ActionIcon>
              </div>
            </div>
            <Title order={4} className="shot-title" mb="sm">
              生成视频 #{idx + 1}
            </Title>
          </Card>
        ))}
        {videoLoading && (
          <Card className="shot-card" padding="lg" radius="lg" shadow="lg" withBorder>
            <Skeleton height={220} radius="md" mb="md" />
            <Skeleton height={18} width="60%" radius="sm" mb="sm" />
            <Skeleton height={14} radius="sm" width="40%" />
          </Card>
        )}
      </SimpleGrid>
    );
  };

  return (
    <div className="app-shell">
      <Container size="xl" py="md">
        <div className="hero">
          <Group justify="space-between" align="center">
            <Title order={1} className="hero-title" onClick={resetHome}>
              StoryGen Atelier
            </Title>
            <Button
              className="log-button"
              size="md"
              variant="gradient"
              gradient={{ from: 'cyan', to: 'indigo' }}
              onClick={() => setShowLogs(true)}
            >
              Log
            </Button>
          </Group>
        </div>

        <Card className="glass-panel" withBorder padding="lg" radius="xl" shadow="xl">
          <form onSubmit={handleSubmit}>
            <Stack gap={8}>
              <Stack gap={4}>
                <Text c="dimmed" className="form-label">
                  故事描述
                </Text>
                <Textarea
                  value={sentence}
                  onChange={(e) => setSentence(e.target.value)}
                  placeholder="输入一句话，例如：在雨中的霓虹都市里，一只猫寻找失落的记忆。"
                  minRows={1}
                  maxRows={4}
                  required
                  autosize
                />
              </Stack>

              <Stack gap={4}>
                <Text c="dimmed" className="form-label">
                  风格
                </Text>
                <Group align="center" gap="md" wrap="wrap">
                  <Select
                    data={stylePresets.map((s) => ({ value: s.value, label: s.label }))}
                    value={styleOption}
                    onChange={(val) => setStyleOption(val || 'cyberpunk')}
                    placeholder="选择风格"
                    maw={240}
                    className="style-select"
                  />
                  {styleOption === 'custom' ? (
                    <TextInput
                      placeholder="自定义风格描述（可中文）"
                      value={customStyle}
                      onChange={(e) => setCustomStyle(e.target.value)}
                      maw={360}
                    />
                  ) : (
                    <Text size="sm" c="dimmed" maw={360}>
                      {stylePresets.find((s) => s.value === styleOption)?.text}
                    </Text>
                  )}
                </Group>
              </Stack>

              <Group align="center" justify="space-between" wrap="wrap" gap="md">
                <div className="slider-block">
                  <Text size="sm" c="dimmed" mb={6} className="form-label">
                    分镜数量：{shotCount} 张
                  </Text>
                  <Slider
                    min={2}
                    max={12}
                    step={1}
                    value={shotCount}
                    onChange={setShotCount}
                    marks={[
                      { value: 3, label: '3' },
                      { value: 6, label: '6' },
                      { value: 9, label: '9' },
                      { value: 12, label: '12' },
                    ]}
                  />
                </div>
                <NumberInput
                  label="精确输入"
                  min={2}
                  max={12}
                  value={shotCount}
                  onChange={(val) => setShotCount(Number(val) || 6)}
                  maw={140}
                />
                <Button type="submit" size="md" variant="gradient" gradient={{ from: 'cyan', to: 'indigo' }} loading={loading}>
                  {loading ? '生成中...' : '生成分镜'}
                </Button>
              </Group>
            </Stack>
          </form>
        </Card>

        {error && (
          <Alert color="red" variant="light" mt="md">
            {error}
          </Alert>
        )}

        {(storyboard || loading) && (
          <div className="section">
            <Group justify="space-between" align="center" mb="md">
              <div>
                <Title order={2} className="section-title">
                  当前分镜
                </Title>
              </div>
              <Group gap="sm">
                <Button variant="subtle" color="gray" onClick={handleSaveStory} disabled={!storyboard}>
                  保存到画廊
                </Button>
                <Button
                  variant="outline"
                  color="teal"
                  onClick={handleGenerateVideo}
                  loading={videoLoading}
                  disabled={!storyboard}
                >
                  {videoLoading ? '生成视频中...' : '从分镜生成视频'}
                </Button>
              </Group>
            </Group>

            {renderShots()}
          </div>
        )}

        {savedStories.length > 0 && (
          <div className="section gallery">
            <Group justify="space-between" align="center" mb="md">
              <div>
                <Title order={2} className="section-title">
                  画廊
                </Title>
              </div>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
              {savedStories.map((story) => (
                <Card key={story.id} className="gallery-card" padding="lg" radius="lg" withBorder shadow="lg">
                  <Image
                    src={story.storyboard?.[0]?.imageUrl}
                    alt={story.title}
                    height={180}
                    radius="md"
                    withPlaceholder
                    className="gallery-image"
                  />
                  <Title order={4} className="gallery-title">
                    {story.title}
                  </Title>
                  <Text size="sm" c="dimmed">
                    {new Date(story.createdAt).toLocaleString()} · {story.shotCount || story.storyboard.length} 张
                  </Text>
                  <div className="gallery-links">
                    <button className="link-btn" onClick={() => handleViewStory(story)}>查看</button>
                    <span className="link-sep">·</span>
                    <button className="link-btn" onClick={() => handleLoadStory(story.id)}>载入</button>
                    <span className="link-sep">·</span>
                    <button className="link-btn" onClick={() => handleDeleteStory(story.id)}>删除</button>
                  </div>
                </Card>
              ))}
            </SimpleGrid>
          </div>
        )}

        <Modal
          opened={!!viewStory}
          onClose={() => setViewStory(null)}
          title={viewStory?.title}
          size="xl"
          radius="lg"
          centered
        >
          {viewStory && (
            <Stack gap="md">
              <Text size="sm" c="dimmed">
                {new Date(viewStory.createdAt).toLocaleString()} · {viewStory.shotCount || viewStory.storyboard.length} 张
              </Text>
              <ScrollArea h={520} type="always" scrollHideDelay={0}>
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                  {viewStory.storyboard.map((shot, idx) => (
                    <Card key={idx} withBorder radius="md" padding="md" className="viewer-card">
                      <Image
                        src={shot.imageUrl}
                        alt={`Shot ${shot.shot}`}
                        height={180}
                        radius="md"
                        withPlaceholder
                        mb="sm"
                      />
                      <Title order={5} className="shot-title">
                        {shot.description}
                      </Title>
                      <Text size="sm" className="shot-prompt">
                        {shot.shotStory || shot.prompt}
                      </Text>
                    </Card>
                  ))}
                </SimpleGrid>
              </ScrollArea>
            </Stack>
          )}
        </Modal>

      </Container>

      <Modal
        opened={showLogs}
        onClose={() => setShowLogs(false)}
        fullScreen
        radius={0}
        transitionProps={{ transition: 'fade', duration: 200 }}
      >
        <VideoLogs onBack={() => setShowLogs(false)} />
      </Modal>

      <Modal
        opened={!!fullscreenVideo}
        onClose={() => setFullscreenVideo(null)}
        size="xl"
        radius="lg"
        centered
        padding={0}
        withCloseButton
        classNames={{ body: 'video-modal-body' }}
      >
        {fullscreenVideo && (
          <video
            src={fullscreenVideo}
            controls
            autoPlay
            style={{ width: '100%', borderRadius: 8 }}
          />
        )}
      </Modal>

      <Modal
        opened={!!previewImage}
        onClose={() => setPreviewImage(null)}
        size="xl"
        radius="lg"
        centered
        padding="md"
        withCloseButton
        classNames={{ body: 'preview-image-modal' }}
      >
        {previewImage && (
          <div style={{ position: 'relative' }}>
            <ActionIcon
              variant="transparent"
              color="gray"
              size="lg"
              radius="md"
              style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
              onClick={() => handleDownloadImage(previewImage.url, previewImage.name)}
              title="下载图片"
            >
              <span style={{ fontSize: 16 }}>⬇</span>
            </ActionIcon>
            <Image
              src={previewImage.url}
              alt="Preview"
              radius="md"
              fit="cover"
              style={{ maxHeight: '80vh', width: '100%' }}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}

export default App;
