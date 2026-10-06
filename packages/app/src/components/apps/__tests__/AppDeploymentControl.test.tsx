import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import {vi,it,expect,beforeEach} from 'vitest';
import {AppDeploymentControl} from '../AppDeploymentControl';
const mocks=vi.hoisted(()=>({getApp:vi.fn(),undeployApp:vi.fn(),refreshApp:vi.fn(),syncApp:vi.fn(),deploy:vi.fn()}));
vi.mock('@/lib/backend/provider',()=>({getBackend:()=>({apps:{getApp:mocks.getApp}})}));
vi.mock('@/stores/apps-store',()=>({useAppsStore:(s:any)=>s(mocks)}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(_key:string,fallback:string)=>fallback})}));
const row:any={id:'a',name:'App',fcStatus:'live',canManageDeployment:true};
beforeEach(()=>{vi.clearAllMocks();mocks.getApp.mockResolvedValue(row);mocks.undeployApp.mockResolvedValue(true);});
it('asks confirmation and only sends undeploy after approval',async()=>{
 render(<AppDeploymentControl app={row}/>);await waitFor(()=>expect(screen.getByRole('button',{name:'卸载部署'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'卸载部署'}));expect(mocks.undeployApp).not.toHaveBeenCalled();
 expect(screen.getAllByText(/代码、会话、数据库和上传文件会保留/).length).toBeGreaterThan(0);
 fireEvent.click(screen.getByRole('button',{name:'确认卸载'}));await waitFor(()=>expect(mocks.undeployApp).toHaveBeenCalledWith('a'));
});
it('does not expose uninstall to a non-admin',async()=>{
 mocks.getApp.mockResolvedValue({...row,canManageDeployment:false});render(<AppDeploymentControl app={{...row,canManageDeployment:false}}/>);
 await waitFor(()=>expect(mocks.getApp).toHaveBeenCalled());expect(screen.queryByRole('button',{name:'卸载部署'})).toBeNull();
});
it('shows accepted as running and failed cleanup as retryable with steps',async()=>{
 const failed={...row,fcStatus:'uninstall_failed',undeployOperation:{status:'failed',steps:{function:{status:'failed',error:'AccessDenied'}}}};
 mocks.getApp.mockResolvedValue(failed);render(<AppDeploymentControl app={failed}/>);
 expect(await screen.findByText('AccessDenied')).toBeInTheDocument();expect(screen.getByRole('button',{name:'重试清理'})).toBeEnabled();
});

it.each(['awaiting_build','uninstalling'])('disables conflicting uninstall in %s',async fcStatus=>{
 const app={...row,fcStatus};mocks.getApp.mockResolvedValue(app);render(<AppDeploymentControl app={app}/>);
 expect(await screen.findByRole('button',{name:'卸载部署'})).toBeDisabled();
});

it('synchronizes authoritative completion to the app list', async () => {
 const finished={...row,fcStatus:'uninstalled'};
 mocks.getApp.mockResolvedValue(finished);
 render(<AppDeploymentControl app={{...row,fcStatus:'uninstalling'}}/>);
 await waitFor(()=>expect(mocks.syncApp).toHaveBeenCalledWith(finished));
});

it('offers normal redeployment instead of a disabled uninstall after cleanup', async () => {
 const app={...row,fcStatus:'uninstalled',undeployOperation:{steps:{function:{status:'succeeded'}}}};
 mocks.getApp.mockResolvedValue(app);render(<AppDeploymentControl app={app}/>);
 expect(await screen.findByRole('button',{name:'重新部署'})).toBeEnabled();
 expect(screen.queryByRole('button',{name:'卸载部署'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'重新部署'}));
 expect(mocks.deploy).toHaveBeenCalledWith('a');
 expect(screen.getByText('查看清理详情')).toBeInTheDocument();
});
