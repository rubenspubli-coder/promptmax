import React, { useState, useEffect } from 'react';
import styles from './Dashboard.module.css';
import { Heart, Clock, CreditCard, LogOut, ChevronRight } from 'lucide-react';

export default function DashboardUser() {
  const [user, setUser] = useState(null);
  const [favorites, setFavorites] = useState([]);
  const [history, setHistory] = useState([]);
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [token, setToken] = useState(localStorage.getItem('authToken'));
  const [userId, setUserId] = useState(localStorage.getItem('userId'));

  useEffect(() => {
    if (!token || !userId) {
      window.location.href = '/';
      return;
    }
    fetchDashboard();
  }, [token, userId]);

  async function fetchDashboard() {
    try {
      setLoading(true);
      const headers = { Authorization: `Bearer ${token}` };

      const dashRes = await fetch(`/api/users/${userId}/dashboard`, { headers });
      if (!dashRes.ok) throw new Error('Falha ao carregar dashboard');
      
      const dashData = await dashRes.json();
      setUser(dashData.user);
      setFavorites(dashData.favorites || []);
      setHistory(dashData.history || []);
      setSubscription(dashData.subscription);
    } catch (err) {
      console.error('Erro:', err);
      alert('Erro ao carregar dashboard');
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('userId');
    window.location.href = '/';
  }

  async function removeFavorite(promptId) {
    try {
      const res = await fetch(`/api/favorites/${userId}/${promptId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setFavorites(favorites.filter(f => f.id !== promptId));
      }
    } catch (err) {
      console.error('Erro ao remover favorito:', err);
    }
  }

  if (loading) return <div className={styles.loading}>Carregando...</div>;
  if (!user) return <div className={styles.error}>Erro ao carregar usuário</div>;

  const daysUntilExpiry = subscription ? Math.ceil((new Date(subscription.end_date) - new Date()) / (1000 * 60 * 60 * 24)) : null;

  return (
    <div className={styles.container}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <div className={styles.userInfo}>
            <div className={styles.avatar}>{user.name?.[0]?.toUpperCase() || 'U'}</div>
            <div>
              <h1>{user.name || user.email}</h1>
              <p>{user.email}</p>
            </div>
          </div>
          <button className={styles.logoutBtn} onClick={handleLogout}>
            <LogOut size={20} />
            Sair
          </button>
        </div>
      </header>

      {/* Subscription Card */}
      <div className={styles.subscriptionCard}>
        <div className={styles.subscriptionInfo}>
          <CreditCard size={24} className={styles.icon} />
          <div>
            <p className={styles.label}>Plano Atual</p>
            <h2 className={styles.plan}>
              {subscription ? subscription.plan.toUpperCase() : 'GRATUITO'}
            </h2>
            {subscription && daysUntilExpiry > 0 && (
              <p className={styles.expiry}>Renova em {daysUntilExpiry} dias</p>
            )}
            {!subscription && (
              <p className={styles.expiry}>Upgrade para acessar prompts premium</p>
            )}
          </div>
        </div>
        {!subscription || daysUntilExpiry < 30 ? (
          <button className={styles.upgradeBtn} onClick={() => window.location.href = '/#pricing'}>
            Fazer Upgrade
            <ChevronRight size={18} />
          </button>
        ) : (
          <div className={styles.activeStatus}>✓ Ativo</div>
        )}
      </div>

      {/* Stats */}
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <Heart size={24} className={styles.statIcon} />
          <div>
            <p className={styles.statLabel}>Favoritos</p>
            <h3 className={styles.statValue}>{favorites.length}</h3>
          </div>
        </div>
        <div className={styles.statCard}>
          <Clock size={24} className={styles.statIcon} />
          <div>
            <p className={styles.statLabel}>Visualizados</p>
            <h3 className={styles.statValue}>{history.length}</h3>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'overview' ? styles.active : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Visão Geral
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'favorites' ? styles.active : ''}`}
          onClick={() => setActiveTab('favorites')}
        >
          Favoritos ({favorites.length})
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'history' ? styles.active : ''}`}
          onClick={() => setActiveTab('history')}
        >
          Histórico ({history.length})
        </button>
      </div>

      {/* Tab Content */}
      <div className={styles.tabContent}>
        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className={styles.overviewTab}>
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Seus Favoritos Recentes</h3>
              {favorites.length > 0 ? (
                <div className={styles.promptGrid}>
                  {favorites.slice(0, 3).map(prompt => (
                    <PromptCard key={prompt.id} prompt={prompt} />
                  ))}
                </div>
              ) : (
                <p className={styles.emptyMessage}>Nenhum favorito ainda. Explore e favorite seus prompts favoritos!</p>
              )}
            </section>

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Visualizados Recentemente</h3>
              {history.length > 0 ? (
                <div className={styles.historyList}>
                  {history.slice(0, 5).map(prompt => (
                    <div key={prompt.id} className={styles.historyItem}>
                      <div className={styles.historyItemContent}>
                        <p className={styles.historyTitle}>{prompt.title}</p>
                        <p className={styles.historyCategory}>{prompt.category}</p>
                      </div>
                      <span className={styles.historyType}>{prompt.tipo}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className={styles.emptyMessage}>Comece a explorar prompts para ver seu histórico!</p>
              )}
            </section>
          </div>
        )}

        {/* Favorites Tab */}
        {activeTab === 'favorites' && (
          <div className={styles.favoritesTab}>
            {favorites.length > 0 ? (
              <div className={styles.promptGrid}>
                {favorites.map(prompt => (
                  <div key={prompt.id} className={styles.favoriteCard}>
                    <PromptCard prompt={prompt} />
                    <button
                      className={styles.removeFavBtn}
                      onClick={() => removeFavorite(prompt.id)}
                      title="Remover dos favoritos"
                    >
                      <Heart size={18} fill="currentColor" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.emptyMessage}>Nenhum favorito ainda.</p>
            )}
          </div>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div className={styles.historyTab}>
            {history.length > 0 ? (
              <div className={styles.historyList}>
                {history.map(prompt => (
                  <div key={prompt.id} className={styles.historyItem}>
                    {prompt.image_url && (
                      <img src={prompt.image_url} alt={prompt.title} className={styles.historyImage} />
                    )}
                    <div className={styles.historyItemContent}>
                      <p className={styles.historyTitle}>{prompt.title}</p>
                      <p className={styles.historyDescription}>{prompt.description}</p>
                      <div className={styles.historyMeta}>
                        <span className={styles.category}>{prompt.category}</span>
                        <span className={styles.tool}>{prompt.tool}</span>
                        <span className={styles.views}>👁 {prompt.views}</span>
                      </div>
                    </div>
                    <span className={`${styles.type} ${styles[prompt.tipo]}`}>{prompt.tipo}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.emptyMessage}>Nenhum histórico ainda.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Componente Auxiliar
function PromptCard({ prompt }) {
  return (
    <div className={styles.promptCard}>
      {prompt.image_url && (
        <img src={prompt.image_url} alt={prompt.title} className={styles.cardImage} />
      )}
      <div className={styles.cardContent}>
        <p className={styles.cardCategory}>{prompt.category}</p>
        <h4 className={styles.cardTitle}>{prompt.title}</h4>
        <p className={styles.cardDescription}>{prompt.description?.substring(0, 60)}...</p>
        <div className={styles.cardMeta}>
          <span>👁 {prompt.views}</span>
          <span>❤️ {prompt.likes}</span>
        </div>
      </div>
      <span className={`${styles.cardType} ${styles[prompt.tipo]}`}>{prompt.tipo}</span>
    </div>
  );
}
