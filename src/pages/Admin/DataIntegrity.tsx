import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const DataIntegrity: React.FC = () => {
  const navigate = useNavigate();

  useEffect(() => {
    navigate('/admin?tab=data-integrity', { replace: true });
  }, [navigate]);

  return null;
};

export default DataIntegrity;
