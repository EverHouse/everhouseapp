import React from 'react';
import AnnouncementManager from '../../../components/admin/AnnouncementManager';

const AnnouncementsTab: React.FC<{ triggerCreate?: number }> = ({ triggerCreate }) => {
    return <AnnouncementManager triggerCreate={triggerCreate} />;
};

export default AnnouncementsTab;
